# Feed Continuation Progress

## 2026-08-15

- Continued the existing formal goal after the litectl V2 migration and real-data-copy reconciliation passed.
- Chose the smallest vertical slice: persistent single-source sessions and pages with mock continuation. Aggregate ranking, real platform adapters, UI work, and production cutover remain outside this phase.
- Defined `FeedSession` as mutable continuation state and `FeedPage` as an immutable audit record linked to its session and completed `RefreshWindow`.
- Kept raw platform cursors internal to the service representation; clients continue by session name.
- Retained the litectl simplification stop condition for every implementation step.
- Implemented the typed FeedSession state machine with deterministic restart/continue, cross-page deduplication, retry from committed state, and an in-process per-session loading lock.
- Added litectl resource definitions for `FeedSession` + `feed-session-status` and immutable `FeedPage` with declarative `page-of` and `page-window` references.
- Kept the only public/storage reference translation in `litectl-resource-facade.ts`; the business service commits typed session/page resources through one repository method.
- Added REST endpoints for create, list/get, ordered messages, and append page. Raw platform cursors are removed from all HTTP resource projections and from fetch failure responses.
- Verified a two-page mock flow across a real process restart. The second page appended one new Message, preserved order and creation time, and produced the expected four strong links.
- Verification passed: 8 unit tests, 9 litectl contract tests, TypeScript, Vite build, and constrained `verify.sh` with `PASS=118 FAIL=0`, 3.524 CPU seconds, and 210.3 MiB peak memory.
- Added real Bilibili continuation without changing the storage boundary: `follow` persists the API offset and `popular` persists the next page number in a versioned, capability-bound cursor.
- Split Bilibili traversal from its CDP loader so complete-page and cursor behavior is covered without browser mocks. The old one-shot fetch still slices to its requested count; continuation never truncates an upstream page.
- Constrained read-only real probes passed without database writes: follow returned 21 then 20 normalized refs, popular returned 20 then 20, and both head/next pairs had zero overlap.
- Added real Zhihu recommend/follow continuation. The adapter stores a normalized `paging.next` path only after validating the Zhihu origin, capability-specific API path, and versioned cursor shape.
- Constrained read-only real probes passed without database writes: recommend returned 6 then 6 normalized refs, follow returned 14 then 18, and both head/next pairs had zero overlap.
- Added real Twitter recommend/following continuation. The adapter captures the current GraphQL GET or POST request template, replays it with the persisted bottom cursor, and never stores temporary authorization, CSRF, or transaction headers.
- Constrained read-only real probes passed without database writes: recommend returned 35 then 35 normalized refs with zero overlap; following returned 42 then 40 with two platform repeats, which the FeedSession published order deduplicates.
- Final constrained verification passed all 118 assertions in 23.280s wall time, using 3.544s CPU and 211.4 MiB peak memory under `CPUQuota=100%`, `MemoryMax=2G`, and `TasksMax=64`.
- Every currently registered source now implements `ContinuationFetcher`. Unknown future platforms or capabilities remain explicit `501 Not Implemented`.
- Added the distinct `bilibili-main-recommend` source using the logged-in homepage recommendation endpoint. Its versioned cursor persists only the four observed fresh counters and validates their progression invariant; WBI signatures, request headers, and `last_showlist` are never persisted.
- A constrained read-only production-adapter probe returned 10 then 9 valid BVID items with zero overlap. The cursor advanced from `(1,1,1,4)` through `(2,2,2,7)` to `(3,3,3,10)` without opening the Refresh database.
- Final validation passed 26 unit tests, 10 litectl contracts, TypeScript, the production build, and the constrained end-to-end suite with `PASS=133 FAIL=0`.

## Stop Evidence

No stop condition was triggered. Subject/Status splitting, UID resolution, link writes, and the only litectl transaction remain below the repository boundary. FeedSession business code contains no SQL, storage-format branch, or manual link/Status write.

## Scale Gate

Resolved before aggregate sessions. A constrained litectl V2 benchmark measured full Status rewrites at 1k, 10k, and 100k refs. The 100k shape was 2.30 MiB of JSON, took 160.7ms median per write, and grew the database by 5.18 MiB per write. This is material and would copy the full browsing history on every appended page.

`orderedMessageRefs` was removed from mutable FeedSession Status. Published order is now derived from immutable FeedPages selected through their declarative `page-of` links, sorted by ordinal, and deduplicated at first occurrence. A second constrained benchmark with 100k refs across 5,000 pages measured 56.6ms median for link query, decoding, validation, and derivation; the complete three-size fixture occupied 14.6 MiB. The generic link query remains inside the ResourceStore facade, while FeedSession business code receives typed pages and contains no SQL or litectl concepts.

The derived-order change passed 18 unit tests, 9 litectl contracts, TypeScript, the production build, and all 118 constrained end-to-end assertions. The final run used 3.582s CPU and 210.6 MiB peak memory over 23.271s wall time.
