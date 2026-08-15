# Refresh litectl ResourceStore Migration

## Goal

Replace Refresh's custom SQLite resource runtime with litectl storage format V2 while preserving the existing HTTP API, resource envelopes, product behavior, and semantic call sites.

This migration is successful only if litectl removes permanent storage machinery from Refresh. It must not move that machinery into business services or require callers to coordinate subject, Status, link, event, or migration writes.

## Completion Standard

- `server/resources.ts`, `server/followees.ts`, `server/refresh.ts`, `server/media.ts`, `server/scheduler.ts`, and API handlers keep their existing persistence-facing call shapes.
- The ResourceStore facade owns PascalCase-to-storage-kind mapping, subject/Status atomic writes, link materialization inputs, and public envelope reconstruction.
- Existing custom `refresh.db` files are recognized and migrated automatically into a new litectl V2 database before the writer becomes available.
- Migration is one-way, creates a preserved backup, reconciles every resource, and never falls back to the old tables after cutover.
- Legacy JSON is not a runtime migration path. Installations that never completed the old JSON-to-SQLite import must run that one-time importer before this cutover.
- Existing public `metadata.creationTimestamp`, labels, annotations, spec, and inline status are preserved.
- `bun test`, `bunx tsc --noEmit`, `./verify.sh`, and an isolated old-database migration reconciliation pass.
- No production database is mutated as part of development or verification.

## Stop Condition

Stop implementation and report evidence when litectl causes permanent runtime or business complexity, including any of the following:

- business services branch on storage format or litectl concepts;
- callers manually coordinate subject and Status writes;
- callers write both JSON references and `resource_links` state;
- common reads require widespread raw SQL outside the ResourceStore facade;
- public resources require pervasive type erasure or storage-only fields;
- the new permanent facade has more concepts, branches, or code without removing equivalent custom persistence machinery.

One-time import and reconciliation code does not by itself trigger the stop condition.

## Existing Baseline

The current implementation is already SQLite-backed. The comparison is therefore not JSON versus SQLite:

- `server/resource-store.ts`: about 750 lines;
- owns DDL, schema seeding, resource versions, JSON validation, manual secondary indexes, writer serialization, legacy import, and business-specific persistence helpers;
- stores status inline in every resource row;
- stores overlays as independent resources but does not materialize their target relationship;
- stores window items as independent resources and reconstructs archives through a custom index join;
- business projections and selectors are currently held in memory after startup.

## Resource Mapping

Public `kind` values remain unchanged. `storageKind` is private to the litectl facade because litectl kinds are lower-case kebab-case.

| Public resource | litectl subject kind | Status kind | Links | Migration source |
| --- | --- | --- | --- | --- |
| `Message` | `message` | `message-status` | later author relation only when the semantic model provides a UID reference | current `Message` row or rebuilt projection |
| `Author` | `author` | `author-status` | none initially | current `Author` row or rebuilt projection |
| `Followee` | `followee` | `followee-status` | none initially | current `Followee` row or rebuilt projection |
| `RefreshWindow` | `refresh-window` | `refresh-window-status` | Status to subject | current `RefreshWindow` row |
| `RefreshWindowItem` | `refresh-window-item` | none | `item-of` to `RefreshWindow` | current item row |
| `FolloweeWindow` | `followee-window` | `followee-window-status` | Status to subject | current `FolloweeWindow` row |
| `FolloweeWindowItem` | `followee-window-item` | none | `item-of` to `FolloweeWindow` | current item row |
| `OverlayEntry` | `overlay-entry` | none | `overlay-for` to its target | current overlay row |
| `Scheduler` | `scheduler` | none | none | current singleton row |
| `MediaObject` | `media-object` | `media-object-status` | none initially | current media row |
| `Account` | `account` | `account-status` | Status to subject | config spec plus current `AccountStatus` row |

Status resources use the subject name as their own name and controller `refresh`. Their spec contains `subjectRef`, `controller`, `observedGeneration`, and `value`; the facade exposes `value` as the existing inline public `status` object.

Window item and overlay references are constructed inside the ResourceStore transaction from the current target UID. Business callers never write link rows or storage references.

## Metadata Mapping

- `metadata.name` maps to litectl resource name.
- `metadata.labels` maps to litectl EAV labels.
- public annotations map to litectl annotations.
- public `metadata.creationTimestamp` must survive migration and rebuild. The spike must decide between a litectl import capability that preserves `created_at` and a single private facade annotation. This decision cannot leak into business code.
- litectl UID, generation, and resourceVersion remain storage metadata until the public Refresh API explicitly adopts them.

## Atomicity

litectl SQL functions join an existing caller transaction. The facade therefore wraps multi-resource operations in `BEGIN IMMEDIATE` and atomically applies:

- subject plus Status;
- window plus all window items;
- overlay plus its target link;
- batch overlay patches.

No business service may sequence these writes itself.

## Migration Boundary

The existing custom SQLite schema and litectl V2 both use a `resources` table but are not format-compatible. Automatic migration therefore uses whole-file replacement:

1. identify a litectl V2 database or the exact known Refresh custom schema;
2. close the source connection;
3. build a new litectl V2 database at a sibling temporary path;
4. register all kinds and import resources through the litectl write API;
5. reconcile counts and canonical public envelopes;
6. checkpoint and close the new database;
7. preserve the old file as `refresh.db.pre-litectl-v2.sqlite`;
8. atomically rename the new database into place;
9. reopen and require litectl V2; never read the backup as fallback.

Development tests use generated fixtures or copies. They do not rename the real `data/refresh.db`.

## Implementation Order

1. Prove Bun extension loading and caller-owned transaction behavior.
2. Define schemas and the centralized public/storage kind mapping.
3. Prove subject/Status split and envelope reconstruction.
4. Prove isolated custom-database conversion and exact reconciliation.
5. Compare permanent facade complexity with the current runtime.
6. Only after the simplification gate passes, replace the current ResourceStore.
7. Run the full Refresh verification suite.
8. Continue feed continuation work on the litectl-backed store.
