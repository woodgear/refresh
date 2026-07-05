# Followees Memory

Use this file for durable implementation notes that should survive context compaction.

- User wants true independent followee lists from Zhihu, Twitter, and Bilibili, not inferred seen authors.
- User accepted `Followee` resource name and separate `FolloweeWindow`.
- `group` label has multi-group semantics. Frontend can compute group list from followee labels.
- Export is JSON only and should include current followees only.
- User notes are required; store as user overlay annotations.
