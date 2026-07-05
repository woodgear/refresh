# SQLite Resource Store Plan

## Goal

Replace Refresh's current file-backed structured persistence with a SQLite-backed unified ResourceStore.

The external API remains k8s-style. Internally, all structured data owned by Refresh is persisted as resources:

- `Message`
- `Author`
- `Followee`
- `RefreshWindow`
- `RefreshWindowItem`
- `FolloweeWindow`
- `FolloweeWindowItem`
- `Scheduler`
- config-derived `Account` resources with SQLite-persisted status
- `MediaObject`
- schema registry resources and storage metadata

The filesystem remains responsible only for unstructured blob bytes, such as image files and future cached video blobs. The blob identity, hash, origin URL, MIME type, local path, lifecycle status, and references are represented by `MediaObject` resources in SQLite.

## Completion Standard

- All structured persistence goes through the new SQLite-backed ResourceStore.
- Business code no longer reads or writes `data/windows`, `data/followee-windows`, `data/overlay`, `data/scheduler.json`, or `data/media/index.json` directly.
- Existing k8s-style HTTP API behavior remains compatible.
- Current data can be migrated into SQLite without losing raw payload traceability, read state, labels, annotations, scheduler config, followee state, or media manifest data.
- Resource writes are transactionally validated, indexed, and persisted.
- Reads can run concurrently; writes are serialized inside the persistence runtime and are not exposed to callers as a queue or lock.
- `verify.sh` and `bunx tsc --noEmit` pass.
- The local service starts and the frontend works against the new store.
- Metrics expose frontend performance and backend slow methods.

## Non-Goals

- Do not redesign the public REST API shape unless required by the storage migration.
- Do not add authentication or public token support.
- Do not turn SQLite into a business-domain schema with separate message/author/window tables.
- Do not rely on service restart as part of verification.
- Do not hide storage failures with fallback file reads.

## Core Design

### Resource As The Persistence Unit

The persistence layer maintains one unified resource model:

```ts
interface Resource<Spec, Status> {
  apiVersion: 'radar/v1'
  kind: string
  metadata: {
    name: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    resourceVersion?: string
    deletionTimestamp?: string
  }
  spec: Spec
  status: Status
}
```

Persistence does not own business object models. It owns resource storage, schema validation, resource versions, transactions, indexes, migrations, snapshots, and change events.

### Resource Definitions

Concrete resource schema belongs to semantic modules, not to the SQLite runtime.

Each resource module defines a `ResourceDefinition`:

```ts
defineResource({
  apiVersion: 'radar/v1',
  kind: 'Message',
  schemaVersion: 1,
  schema: messageJsonSchema,
  indexes: {
    sources: setIndex('metadata.annotations["radar/sources"]'),
    publishedAt: scalarIndex('spec.publishedAt'),
    author: scalarIndex('spec.author.name'),
    read: scalarIndex('status.read'),
  },
})
```

The same definition drives:

- JSON Schema stored in SQLite;
- TypeScript types;
- runtime validation;
- index extraction;
- migration checks;
- revalidation and index rebuild tools.

JSON Schema is the source of truth. Runtime validators should be compiled from JSON Schema, not hand-maintained independently.

### Layering

The intended layering is:

```text
Semantic services
  MessageService.markRead, RefreshService.createWindow, MediaService.localize

Typed resource repositories
  repo(Message).get/list/put/patchStatus/project

Generic ResourceStore
  resource CRUD, transactions, snapshots, validation, index update, watch

SQLite runtime
  connections, WAL, schema migrations, single writer serialization, readonly reads
```

`markRead` is not a persistence method. It belongs in semantic service code. The persistence layer may provide generic optimized methods such as `patchManyStatus`, but it must not encode product semantics.

### Read/Write Concurrency

The caller should not know about write queues or SQLite connections.

Persistence runtime responsibilities:

- use WAL mode;
- allow concurrent readonly snapshots;
- serialize write transactions internally;
- validate the final resource state before commit;
- update resource body and indexes in the same transaction;
- expose semantic transaction APIs, not locks or queues.

Allowed public shape:

```ts
await store.transaction(async tx => {
  await tx.resources.put(resource)
  await tx.resources.patch(ref, patch)
})
```

Disallowed public shape:

```ts
await store.writerQueue.run(...)
await store.withWriteLock(...)
await store.writeConnection(...)
```

### SQLite Tables

Use a unified JSONB-style resource table plus schema and index tables.

SQLite `JSONB` is a semantic type name here. SQLite enforces JSON validity with `json_valid`; full JSON Schema validation happens in the ResourceStore using validators compiled from the registered JSON Schemas.

```sql
CREATE TABLE resource_schemas (
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  json_schema JSONB NOT NULL CHECK (json_valid(json_schema)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_version, kind, schema_version)
);

CREATE TABLE resources (
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  resource_version INTEGER NOT NULL,
  metadata JSONB NOT NULL CHECK (json_valid(metadata)),
  spec JSONB NOT NULL CHECK (json_valid(spec)),
  status JSONB NOT NULL CHECK (json_valid(status)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (api_version, kind, name),
  FOREIGN KEY (api_version, kind, schema_version)
    REFERENCES resource_schemas(api_version, kind, schema_version)
);

CREATE TABLE resource_index_terms (
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (api_version, kind, name, field, value),
  FOREIGN KEY (api_version, kind, name)
    REFERENCES resources(api_version, kind, name)
    ON DELETE CASCADE
);

CREATE INDEX idx_resource_index_terms_lookup
ON resource_index_terms(kind, field, value);

CREATE TABLE resource_index_values (
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  field TEXT NOT NULL,
  text_value TEXT,
  number_value REAL,
  boolean_value INTEGER,
  PRIMARY KEY (api_version, kind, name, field),
  FOREIGN KEY (api_version, kind, name)
    REFERENCES resources(api_version, kind, name)
    ON DELETE CASCADE
);

CREATE INDEX idx_resource_index_values_text
ON resource_index_values(kind, field, text_value);

CREATE INDEX idx_resource_index_values_number
ON resource_index_values(kind, field, number_value);

CREATE INDEX idx_resource_index_values_boolean
ON resource_index_values(kind, field, boolean_value);

CREATE TABLE store_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
```

Additional internal tables may be added only if they preserve the unified resource abstraction. They should not become business-domain persistence tables.

### Query Model

Business and API layers should use typed queries, not raw selector strings or SQL.

Examples:

```ts
messages.list({
  where: and(
    Message.index.sources.has(source),
    Message.index.read.eq(false),
  ),
  orderBy: Message.index.publishedAt.desc(),
  limit: 200,
})

messages.project({
  fields: ['metadata.name', 'spec.title', 'status.read'],
  where: Message.index.sources.has(source),
})
```

The persistence layer should fail fast when a query requires an undeclared index. It should not silently scan all resources in normal application paths.

Initial cutover indexes must cover current API and UI paths only:

- `Message`
  - `metadata.annotations["radar/sources"]` as a set index;
  - `metadata.labels.platform`;
  - `spec.author.name`;
  - the current published/sort timestamp field;
  - `status.read`;
- `Author`
  - `metadata.labels.category`;
- `Followee`
  - `metadata.labels.platform`;
  - `metadata.labels.account`;
  - `metadata.labels.group` as a set index;
  - `status.following`;
- `RefreshWindow`
  - `spec.source`;
  - `status.phase`;
  - `metadata.creationTimestamp`;
- `FolloweeWindow`
  - `spec.account`;
  - `status.phase`;
  - `metadata.creationTimestamp`;
- `MediaObject`
  - `spec.hash`;
  - `spec.originUrl`;
  - `status.phase`.

`Scheduler` is a singleton and does not need an index. Followee text search remains frontend-local in the first cutover. Backend indexed full-text or fuzzy search should be added later through FTS5, not mixed into the initial persistence migration.

### ResourceStore Optimizations

Because all structured data is a resource, the persistence layer may provide generic optimizations:

- typed projection;
- index-aware query builder;
- `patchMany` / `patchManyStatus`;
- snapshot reads;
- resource watch/change feed;
- revalidate resource kind;
- rebuild indexes for a resource kind;
- rematerialize derived resources from raw item resources;
- object reference and reverse-reference lookup.

These are resource-generic capabilities, not business actions.

`RefreshWindow` SSE stays owned by the refresh semantic service in the first cutover. ResourceStore may emit internal change events, but the public `watch=1` stream has business-specific events such as logs, progress, and final job status. The refresh service should compose ResourceStore changes and job logs while preserving current API behavior. A generic resource watch API can be extracted later after the store event model is proven.

### Migration Strategy

The migration should be explicit and one-way for this phase.

Sources to migrate:

- `data/windows/*.json` -> `RefreshWindow` and `RefreshWindowItem` resources;
- normalized message/author projections -> `Message` and `Author` resources;
- `data/followee-windows/*.json` -> `FolloweeWindow` and `FolloweeWindowItem` resources;
- followee projections -> `Followee` resources;
- `data/overlay/*.json` -> resource metadata/status patches in final resource state;
- `data/scheduler.json` -> `Scheduler` resource;
- `data/media/index.json` -> `MediaObject` resources.

Raw payload traceability must survive migration. Normalized projections must remain rebuildable from raw item resources and current resource definitions.

After successful migration, legacy JSON files stay on disk as read-only backup, but runtime code must not read them as fallback. The migration writes a manifest under `data/migration-snapshots/<timestamp>/manifest.json` with imported file paths, hashes, resource counts, and migration version. Service startup reads SQLite only.

`Account.spec` remains config-derived from `server/config.ts`. SQLite stores account runtime status, such as auth state, checked time, errors, and scheduler observations. The external `Account` resource is assembled from config spec plus persisted status.

### Observability

Add an observability system as part of this refactor. This is not part of the ResourceStore resource model.

Frontend telemetry is RUM-style performance telemetry:

- Core Web Vitals via the `web-vitals` library;
- browser Navigation Timing and Performance APIs;
- route transition timings;
- API request duration from the browser;
- feed query latency and render-cost samples where practical;
- optional trace context propagation from frontend API calls to backend spans.

Backend telemetry uses OpenTelemetry concepts:

- traces for HTTP requests, refresh jobs, followee sync jobs, media localization, ResourceStore operations, migrations, and scheduler rounds;
- span attributes for resource kind, source, account, route, status, and item counts;
- metrics for request duration, operation duration, validation failures, resource writes, transaction duration, and slow operations;
- logs should carry trace/span context when possible.

Initial local APIs:

```text
GET  /metrics                 # Prometheus/OpenMetrics-style scrape endpoint
POST /api/v1/rum              # browser RUM intake
GET  /api/v1/observability    # local summary for the admin UI
```

Telemetry storage is separate from `resources`. For the first implementation, keep a small local ring buffer or observability-specific SQLite tables under the observability subsystem. Do not store high-cardinality spans or RUM samples as normal resources. ResourceStore should emit spans and metrics; it should not own observability persistence.

Preferred backend candidate: OpenObserve. It is Rust-based, can run as a single binary, supports logs/metrics/traces/RUM, accepts OpenTelemetry data, has its own UI for querying and dashboards, and can run in local SQLite + local disk mode for light usage. This matches Refresh's single-machine deployment better than ClickHouse/PostgreSQL/Redis stacks such as SigNoz, Uptrace, OneUptime, or HyperDX.

Keep OpenTelemetry Collector in the design as the standard telemetry pipeline boundary. The collector can receive OTLP, sample/filter/enrich, and export to OpenObserve. SQLite collector storage/exporter options are useful for experimentation or local buffering, but they are not the primary observability backend unless OpenObserve proves unsuitable.

Refresh may expose a small local observability summary in the admin page, but deep inspection of traces, logs, RUM, dashboards, and alerts should happen in OpenObserve's UI.

## Phases

1. Define resource schema/definition mechanism.
2. Add SQLite runtime, migrations, schema registry, and generic resource CRUD.
3. Add typed repositories and query/index layer.
4. Add data migration from current files into SQLite.
5. Port resources/messages/authors/windows to ResourceStore.
6. Port followees/followee windows to ResourceStore.
7. Port scheduler and media manifest to ResourceStore.
8. Add metrics collection and API.
9. Remove direct structured file persistence paths.
10. Run verification, start service, and smoke test frontend.

## Open Questions

No open design questions remain before implementation. New questions should be recorded in `store/sqlite-resource-store/progress.md` with the decision and reason.
