# Feed UI

## Goal

Replace the archive-query feed with real FeedSession consumption while preserving the existing compact operational UI. Each feed key owns a generation, a stable local message position, bounded message pages, and explicit continuation/restart actions.

## Completion Standard

- `all` creates an aggregate session with the explicit default recommendation sources; a source entry creates a single-source session.
- A persisted session is reused after navigation or reload and its `{messageName, offset}` position is restored with one bounded message page.
- Near-bottom loading consumes local message pagination before requesting one platform continuation page.
- Existing items never reorder when more content arrives. A failed request stays visible and can be retried.
- Restart explicitly creates a new generation, resets its saved position, and retains the old immutable session in storage.
- Updates are a real local count of unpublished messages observed after the active generation started; switching generations clears the visible count by establishing a new baseline.
- Loading, empty, exhausted, retry, and mobile/desktop states are all explicit.

## Stop Condition

Stop and notify the user if UI integration requires litectl queries, raw platform cursors, manual Status/link writes, storage-format branches, or a second client-side copy of published-order semantics.
