# Refresh litectl ResourceStore Progress

## 2026-08-15

- Created the formal migration goal after litectl storage format V2 passed its constrained 100k-resource acceptance suite.
- Confirmed both Maid and Refresh worktrees were clean before starting.
- Recovered the prior feed continuation plan and HTML mockup. Continuation currently has only the deterministic fetcher page contract; session/page persistence and UI behavior remain unimplemented.
- Established that Refresh already has a custom SQLite ResourceStore, so the migration must remove that implementation rather than layer litectl beneath it.
- Measured the current storage runtime at about 750 lines in `server/resource-store.ts`, plus an 11-kind registry with minimal schema information.
- Confirmed litectl SQL functions participate in a caller-owned transaction. This permits atomic subject/Status and window/item writes inside the facade and avoids business-layer dual writes.
- Identified the private kind mapping requirement: Refresh public kinds are PascalCase while litectl storage kinds are lower-case kebab-case.
- Defined the initial resource, Status, and link mapping in `spec.md`.
- Deferred any production database mutation. The real database is read-only input for baselining only; migration verification will use isolated fixtures or copies.

## Simplification Gate

Current result: passed.

- The permanent implementation is split into a small extension/runtime adapter, a centralized public-envelope facade, and declarative resource definitions.
- Business services and API handlers did not gain storage-format branches, manual Status writes, link writes, or raw SQL.
- `server/resource-store.ts` dropped from 750 to about 350 lines and no longer owns DDL, resource versions, secondary-index rebuilds, schema validation, or a writer queue.
- Subject and Status writes join one caller transaction. Window items and overlays materialize links from JSON references inside the same transaction.
- The old custom database converter is isolated one-time code and performs full public-envelope reconciliation before cutover.

## Implementation And Verification

- Added automatic format detection, consistent backup, sibling V2 conversion, reconciliation, and atomic path replacement.
- Added explicit V2 extension extraction through `LITECTL_BIN` and a startup format-version gate.
- Added contract coverage for caller-owned transactions, Status links/events, public envelope reconstruction, 64-character media hashes, window/overlay links, custom database conversion, and in-place backup/cutover.
- Found a real raw-payload fidelity failure during the first full-data reconciliation: serde_json changed `1.1666666666666665` to `1.1666666666666663`.
- Fixed litectl itself by enabling `serde_json/float_roundtrip`; no tolerance or Refresh-side compatibility patch was added.
- `bun test`: 3 pass.
- litectl contract: 7 pass.
- `bunx tsc --noEmit`: pass.
- `bun run build`: pass.
- `./verify.sh`: `PASS=105 FAIL=0` using the V2 binary.
- Real-data copy migration under one CPU, 2 GiB, 64 tasks: 61,466 public resources -> 92,408 storage resources, 30,942 Status links, 30,523 business links; 36.6 seconds, 1.7 GiB peak.
- Migrated copy `PRAGMA integrity_check`: `ok`; API short-start rebuilt 5,341 messages, 3,469 authors, 6,564 followees, 226 refresh windows, and 13 followee windows.
- The real `data/refresh.db` was not modified.

## Stop Evidence

No stop condition was triggered. The raw-number drift was fixed in litectl itself; Refresh did not gain a tolerance or compatibility branch.

## Production Cutover Preparation

- Confirmed `refresh.service` is the production owner and directly listens on port 13002; the old tmux split-port script is not active.
- Confirmed the running service resolves `litectl` to `/usr/local/bin/litectl`.
- A read-only in-memory extension probe showed that `/usr/local/bin/litectl` creates format 1, while the reviewed Maid artifact creates format 2. Restarting the V2 Refresh code before publishing the V2 binary is therefore forbidden and would fail at the startup gate before touching the database.
- Added the authoritative binary publication, service cutover, acceptance, and database rollback checklist to the devops SQLite operations document. No binary, service, or production database was changed while preparing it.
- The real database remains the exact custom ResourceStore schema, passes `PRAGMA integrity_check`, and has no migration backup or temporary target yet.
- Added a failed in-place migration contract that creates the backup, then rejects an invalid public envelope. It proves the source file remains byte-identical and both backup and temporary V2 artifacts are removed when conversion fails.
- Re-ran the V1-to-V2 evidence under `CPUQuota=100%`, `MemoryMax=2G`, and `TasksMax=64`: four Rust format tests and the Go writer suite passed, including concurrent migration, backup, lifecycle/event reconciliation, and the read-only migration gate.
- Re-ran the complete Refresh acceptance chain under the same limits: 30 unit tests (104 assertions), 11 litectl contracts (34 assertions), typecheck, production build, and `PASS=140 FAIL=0`; peak memory was 522.8 MiB.

## Continuation Follow-through

- The first post-migration feature now uses `FeedSession` + independent Status and immutable `FeedPage` resources.
- `page-of` and `page-window` links are declared in schemas and resolved by the facade; the FeedSession service contains no litectl branch, raw SQL, UID handling, or manual Status/link write.
- This follow-through preserves the migration simplification result; no stop condition was triggered.
