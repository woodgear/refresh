# Feed Continuation

## Goal

Implement persistent single-source feed continuation on the litectl-backed ResourceStore. A client can create a new feed generation, append pages without changing the published order, restart the server, and continue from the committed cursor.

This phase does not implement aggregate ranking, real platform cursor adapters, update polling, or the web UI.

## Completion Standard

- `POST /api/v1/feedsessions` fetches a source head and creates one `FeedSession`, `FeedPage`, and completed `RefreshWindow`.
- `POST /api/v1/feedsessions/{name}/pages` fetches the committed next cursor and appends one page.
- `GET /api/v1/feedsessions/{name}/messages` returns messages in the session's stable published order.
- A new service instance can load the session and continue from the same cursor.
- A fetch or archive failure leaves the committed cursor and ordered message refs unchanged; retry requests the same cursor.
- Duplicate message refs remain in the immutable page/window audit record but are appended to the session order only once.
- Concurrent page requests for one session are rejected explicitly.
- Platform cursors remain server-side; API clients continue by session name and never receive the raw cursor.

## Resource Model

```text
FeedSession
  spec:
    source
    generation
  status:
    nextCursor       # internal; removed from the HTTP representation
    hasMore
    orderedMessageRefs
    pageCount
    lastPage
    lastWindow

FeedPage
  spec:
    session          # facade maps to a strong sessionRef
    window           # facade maps to a strong windowRef
    ordinal
    mode             # restart | continue
    inputCursor
    outputCursor
    hasMore
    fetchedAt
    messageRefs      # complete page membership, including duplicates
```

`FeedPage` declares `page-of` and `page-window` links. Callers provide public names only; the ResourceStore facade resolves UID references and litectl materializes links.

## Commit Boundary

Fetching and media work happen before the session transition. The completed window is archived first. `FeedSession` and `FeedPage` are then written in one caller-owned litectl transaction. The session cursor advances only in that final transaction.

An archive that succeeds before the final transaction but whose session transition fails remains an unreferenced audit window. It does not advance the session and can be diagnosed independently. No runtime fallback or repair branch is added.

## Stop Condition

Stop and notify the user if this implementation requires business code to split subject and Status, write links, branch on storage format, query litectl tables directly, erase resource types, or carry more permanent storage machinery than the prior ResourceStore behavior it replaces.
