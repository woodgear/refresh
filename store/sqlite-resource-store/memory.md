# SQLite Resource Store Memory

- The external API is already k8s-style; the refactor is about making internal structured persistence match that model.
- Persistence layer maintains unified resources only. It must not grow separate business tables for messages, authors, windows, followees, scheduler, or media manifest.
- Concrete `spec` and `status` schemas belong to semantic resource modules.
- JSON Schema is the source of truth. Runtime validation should be compiled from JSON Schema.
- SQLite stores JSONB-style resource parts and schema rows. SQLite `json_valid` is only syntax validation; full schema validation is in ResourceStore.
- Business code should call typed semantic services or typed resource repositories, not raw SQL, raw kind strings, or file paths.
- Writer serialization is an internal persistence runtime detail. Do not expose writer queues, locks, or write connections to callers.
- Read paths should be concurrent through WAL and readonly snapshots.
- ResourceStore can expose generic optimizations such as projection, index-aware queries, patch-many, snapshots, revalidation, index rebuilds, and watch events.
- `markRead` is semantic service behavior. Persistence can optimize generic status patching, but should not own the `markRead` business concept.
- Blob bytes stay in the filesystem. Blob metadata and lifecycle are `MediaObject` resources in SQLite.
- Metrics are part of the target system: frontend performance, backend slow methods, SQLite transaction timing, validation failures, and resource operation counts.
