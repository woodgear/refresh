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

## Stop Evidence

No stop condition was triggered. Subject/Status splitting, UID resolution, link writes, and the only litectl transaction remain below the repository boundary. FeedSession business code contains no SQL, storage-format branch, or manual link/Status write.

## Scale Gate

`FeedSession.status.orderedMessageRefs` is rewritten when a page commits. Before implementing long-lived aggregate sessions, benchmark this shape at the intended session length. If rewrite cost becomes material, derive order from immutable FeedPages or add a purpose-built ordered membership resource; do not add raw SQL to the business service.
