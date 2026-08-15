# Feed UI Progress

## 2026-08-15

- Started after FeedSession message reads gained stable bounded pagination and passed `PASS=139 FAIL=0`.
- Chose persisted session names plus `{messageName, offset}` positions per feed key. Reload reads one bounded page at that offset and validates the anchor; the server remains authoritative for ordering, pagination, continuation, and update counts.
- Added server-side typed update derivation from Message source membership, unpublished refs, and the last observing RefreshWindow time. Missing window references fail explicitly.
- Replaced archive queries in the React feed with a single UI state machine: generation create/reuse, bounded local page reads, platform continuation at the local tail, stable append, explicit retry, and restart.
- `all` now submits the explicit Zhihu/Twitter/Bilibili recommendation list. Source navigation creates independent sessions; switching back reuses the prior generation.
- Persisted only public session names and Message positions. Removed time/unread sorting from the continuous feed because either would reorder already published cards; those controls belong to a future archive inbox.
- Added compact loading, empty, retry, restarting, update-count, and exhausted states without changing the existing operational visual language.
- Browser/CDP verification passed with isolated mock storage: one initial session under React StrictMode, aggregate near-bottom continuation to page 2, source switch and session reuse, direct reload at the saved non-zero offset with the same first visible Message, explicit restart retaining the old session, and no 390px viewport overflow.
- Final validation passed 30 unit tests, 10 litectl contracts, TypeScript, production build, and constrained `verify.sh` with `PASS=140 FAIL=0`.

## Stop Evidence

No stop condition was triggered. The UI consumes public FeedSession APIs only; update derivation reads typed in-memory projections and adds no litectl query, SQL, UID, Status, link, or storage-format behavior.
