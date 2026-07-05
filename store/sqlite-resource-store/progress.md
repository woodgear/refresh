# SQLite Resource Store Progress

## 2026-06-21

- Created this plan directory after the current file-backed overlay race caused Refresh to stop.
- Root cause from investigation:
  - `atomicWrite` used `tmp-${process.pid}`.
  - concurrent writes in the same Bun process reused the same temp path.
  - this caused `rename ... ENOENT`.
  - even with unique temp names, the current file overlay read-modify-write model still has lost-update risk.
- Design decision:
  - replace file-backed structured persistence with a SQLite-backed unified ResourceStore;
  - keep k8s-style external API;
  - store all structured data as resources;
  - keep blob bytes on disk, represented by `MediaObject` resources;
  - use JSON Schema as source of truth for resource definitions;
  - compile runtime validators from JSON Schema;
  - let semantic modules own concrete `spec` and `status` schemas;
  - let persistence own resource storage, schema registry, transactions, validation, indexing, migrations, snapshots, and watch events;
  - hide writer serialization below the ResourceStore API.

## Current Status

- SQLite ResourceStore implementation is in place.
- `bun:sqlite` is usable after adding the system symlink `/usr/lib/sqlite3 -> /usr/lib/libsqlite3.so`.
- Legacy JSON data has been imported into `data/refresh.db`.
- Existing service was not started through `scripts/start-k2-tmux.sh` because `REFRESH_PUBLIC_URL` is not set in the current shell.

## Decisions

- Legacy JSON files remain as read-only backup after successful migration.
- Runtime code must not fallback to legacy JSON files after migration.
- Migration writes a manifest under `data/migration-snapshots/<timestamp>/manifest.json` with imported paths, hashes, resource counts, and migration version.
- `Account.spec` remains config-derived from `server/config.ts`; SQLite persists account runtime status only.
- Metrics/observability are not normal resources. Frontend telemetry should follow RUM/Web Vitals patterns. Backend telemetry should use OpenTelemetry concepts. Local storage, if needed, belongs to an observability subsystem, not the ResourceStore resource table.
- Observability backend search result: prefer OpenObserve as the first candidate because it is Rust-based, single-binary, supports RUM plus logs/metrics/traces, accepts OTel data, has its own UI, and can run in local SQLite + local disk mode. Keep OTel Collector as the pipeline boundary. Refresh can keep a small admin summary, but deep inspection belongs in OpenObserve UI.
- Initial cutover indexes cover only current API/UI paths: message source/platform/author/time/read, author category, followee platform/account/group/following, refresh window source/phase/time, followee window account/phase/time, media hash/origin/status. Followee text search remains frontend-local; backend FTS5 is deferred.
- `RefreshWindow` SSE remains owned by the refresh semantic service in the first cutover. ResourceStore may emit internal change events, but public `watch=1` should preserve existing business-specific log/progress/done semantics through the refresh service wrapper.

## Implementation Log

- Added `server/resource-definitions.ts` so resource loading/listing uses typed `ResourceDefinition` objects instead of raw kind strings at business call sites.
- Added `server/resource-store.ts` with SQLite tables for `resource_schemas`, `resources`, `resource_index_terms`, `resource_index_values`, and migrations.
- Switched window archives, followee windows, overlays, scheduler spec, account auth status, media manifest, and current projections into SQLite-backed resources.
- Kept blob bytes in `data/media`; represented blob metadata as `MediaObject` resources.
- Added legacy import from:
  - `data/windows/*.json`
  - `data/followee-windows/*.json`
  - `data/overlay/*.json`
  - `data/scheduler.json`
  - `data/media/index.json`
- Added migration manifest writing under `data/migration-snapshots/<timestamp>/manifest.json`.
- Added observability runtime:
  - backend HTTP duration metrics;
  - ResourceStore write transaction timing;
  - resource write counters;
  - validation failure counters;
  - `GET /metrics`;
  - `POST /api/v1/rum`;
  - `GET /api/v1/observability`.
- Added frontend RUM collection for navigation timing, paint/Web Vitals where supported, and API fetch duration.
- Updated `verify.sh` to assert SQLite ResourceStore persistence and observability endpoints.
- Optimized startup so existing Message/Followee projections are not rewritten on every boot.

## Verification

- `bunx tsc --noEmit` passed.
- `./verify.sh` passed with `PASS=102 FAIL=0`.
- `bun run build` passed.
- Real `data/refresh.db` contains:
  - `Author`: 2925
  - `Followee`: 6564
  - `FolloweeWindow`: 13
  - `FolloweeWindowItem`: 17309
  - `MediaObject`: 13210
  - `Message`: 4498
  - `OverlayEntry`: 4140
  - `RefreshWindow`: 164
  - `RefreshWindowItem`: 7119
  - `Scheduler`: 1
- Real data short-start with `RADAR_AUTH_PRECHECK=off RADAR_SCHEDULER=off PORT=13992 bun server/index.ts` succeeded:
  - API ready in about 1 second;
  - `/api/v1/messages?limit=1` returned 200;
  - `/api/v1/observability` returned 200;
  - `/metrics` exposed HTTP request metrics.

## Grill-Me Queue

No open grill-me questions remain before implementation.
