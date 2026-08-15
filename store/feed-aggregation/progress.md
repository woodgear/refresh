# Feed Aggregation Progress

## 2026-08-15

- Started only after the 100k FeedSession order benchmark moved published order out of mutable Status.
- Chose explicit ordered source lists, deterministic round-robin, independent per-source cursor state, and partial success with explicit failed sources.
- Kept Bilibili popular distinct from a future personalized recommendation source.
- Added typed AggregateFeedPage and FeedSourcePage resources. Their declarative references materialize session, batch, and window links without business-layer UID handling.
- Implemented deterministic round-robin, per-source O(1) cursor state, restart/continue, cross-page deduplication, source exhaustion, and an in-process per-session loading lock.
- Restricted partial success to platform fetch failures. Adapter contract violations and archive failures abort the transition and remain visible.
- Added API routing for mutually exclusive `source` and ordered `sources` inputs. Aggregate session and source page projections remove every platform cursor.
- Verified the full mock flow across a server restart: both source cursors resumed, the second page appended without reorder, all sources exhausted, and all expected strong links were present.
- Validation passed: 25 unit tests, 10 litectl contract tests, TypeScript, production build, and constrained `verify.sh` with `PASS=133 FAIL=0` (3.699s CPU, 222.7 MiB peak, 23.381s wall time).

## Stop Evidence

No stop condition was triggered. Business code uses typed FeedSession, AggregateFeedPage, and FeedSourcePage resources. Subject/Status splitting, UID resolution, link materialization, transactions, and the only link query remain below the repository boundary.
