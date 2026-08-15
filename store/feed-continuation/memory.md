# Feed Continuation Memory

- Implement single-source persistence before aggregate feeds or UI integration.
- FeedSession owns mutable continuation state; FeedPage and RefreshWindow are immutable audit resources.
- API callers continue by FeedSession name. Never expose a platform cursor in HTTP responses.
- A page transition commits FeedSession and FeedPage atomically only after the window archive succeeds.
- Retry after failure must fetch the same committed cursor.
- Preserve complete page membership, but deduplicate only when appending to `orderedMessageRefs`.
- Links are declared in resource schemas and resolved by the facade; business services never write link rows or UID references.
- Do not mutate the real database during development or verification.
- Every currently registered Zhihu, Bilibili, and Twitter source supports real continuation. Unknown future sources remain explicit 501; never fall back to head fetch.
- Persist Zhihu next URLs only as validated same-origin relative paths bound to their capability.
- Persist only Twitter's capability-bound bottom cursor. Capture fresh GraphQL templates and temporary auth headers for each request; never store those headers.
- Treat requested count as a target for cursor adapters. Preserve the complete final upstream page so advancing its cursor cannot lose unreturned tail items.
- Before long-lived aggregate sessions, benchmark whole-status rewrites for `orderedMessageRefs` and revisit the model if they become material.
