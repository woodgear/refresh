# Feed Aggregation Memory

- Aggregate source order is explicit API input and is also the deterministic ranker order.
- Never alias Bilibili popular as personalized recommend.
- Preserve complete source fetch membership in FeedSourcePage and publish only ranked unique refs in AggregateFeedPage.
- A failed source keeps its committed cursor. Successful sources can still commit in the same logical page.
- All active sources failing means no state transition.
- Partial success applies only to platform fetch failure. Archive and adapter contract errors abort the whole transition.
- Raw platform cursors and raw adapter errors remain internal.
- Subject/Status, UID, link, transaction, and SQL mechanics stay below the repository boundary.
