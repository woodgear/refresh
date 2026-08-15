# Feed Aggregation

## Goal

Add persistent multi-source FeedSessions without changing the single-source continuation contract. An API client supplies an explicit ordered source list, receives deterministic cross-source pages, and can continue after a process restart.

## Completion Standard

- `POST /api/v1/feedsessions` accepts either one `source` or an ordered `sources` array, never both.
- Aggregate restart fetches the head of every source and persists independent source cursor state.
- Aggregate continuation fetches only sources whose state still has more content.
- The first ranker is deterministic round-robin in requested source order and only ranks unpublished refs.
- A source fetch failure does not advance that source cursor and does not block successful sources; the failed source is explicit in the page and session status.
- If every active source fails, no session/page state is committed.
- Each successful source fetch has an immutable `RefreshWindow` and `FeedSourcePage` with complete membership.
- Each logical aggregate request has one immutable `AggregateFeedPage` containing the published message order.
- FeedSession, AggregateFeedPage, and all FeedSourcePages commit atomically after successful archives.
- Platform cursors remain absent from every HTTP response.

## Resource Model

```text
FeedSession
  spec:
    source: aggregate
    sources: ordered source names
    generation
  status:
    hasMore
    pageCount
    lastPage
    sourceStates[source]:
      nextCursor
      hasMore
      lastWindow
      lastError

AggregateFeedPage
  spec:
    session
    ordinal
    mode
    messageRefs
    failedSources

FeedSourcePage
  spec:
    session
    page
    window
    source
    inputCursor
    outputCursor
    hasMore
    fetchedAt
    messageRefs
```

Reference fields are public names at the service boundary. The ResourceStore facade resolves UIDs and litectl materializes `page-of`, `source-page-of`, `source-page-batch`, and `source-page-window` links.

## Source Selection

Aggregate sources are explicit API input. No default aliases Bilibili popular to personalized recommend, and no aggregate silently mixes recommend and follow capabilities. The product-level default is the ordered recommendation list exported by `server/config.ts`; the API still receives that list explicitly from its consumer.

## Stop Condition

Stop and notify the user if aggregate implementation requires business code to split subject and Status, write links or UIDs, branch on storage format, query litectl tables, erase resource types, or add storage-specific recovery behavior.
