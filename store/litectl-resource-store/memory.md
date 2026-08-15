# Refresh litectl ResourceStore Memory

- The migration compares litectl with Refresh's existing custom SQLite ResourceStore, not with the older JSON-file runtime.
- Preserve all public PascalCase kinds; map them to lower-case litectl kinds only inside resource definitions and the ResourceStore facade.
- Business code must continue reading and writing resources with inline `status`. The facade atomically splits and rejoins business-specific litectl Status resources.
- litectl SQL functions join a caller-owned transaction, so multi-resource writes can remain atomic.
- Status names equal subject names; status controller is `refresh`.
- Window items and overlays should declare references so litectl materializes `item-of` and `overlay-for` links. Callers never write links directly.
- Do not add a Message-to-Author link until the semantic resource model can provide a full UID reference without duplicating mutable identity in business code.
- Existing custom `refresh.db` is not litectl V1. It requires a one-time whole-file conversion into a sibling V2 database, reconciliation, backup, and atomic rename.
- Never mutate the real database during development verification.
- A complex one-time migrator is acceptable; a complex permanent facade or business-layer litectl branching is not.
- Raw payload reconciliation is exact. litectl must use serde_json `float_roundtrip`; never weaken reconciliation to tolerate numeric drift.
- Production Refresh uses `/usr/local/bin/litectl`; require an in-memory extension probe returning format 2 before restarting the V2 application.
- The production database is outside the k2 Litestream-managed root. Its immediate rollback source is `refresh.db.pre-litectl-v2.sqlite`, created and integrity-checked by the automatic migration.
- Failed custom-store conversion must leave the source database byte-identical and remove the uncommitted backup and temporary V2 database; this is a contract test, not an assumed property.
- Production Refresh has used storage format V2 since the authorized 2026-08-15 cutover. The preserved custom-store rollback source is `data/refresh.db.pre-litectl-v2.sqlite`; deployment hashes and runtime counts live only in the devops SQLite operations document.
- A post-cutover real aggregate request caused one Bun 1.3.5 SIGILL before the FeedSession/page transaction. systemd recovery, isolated and production replays, page-2 continuation, and browser rendering all succeeded; keep this as a Bun runtime incident, not a reason to add storage fallback logic without contrary evidence.
