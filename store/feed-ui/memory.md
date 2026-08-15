# Feed UI Memory

- `all` means the explicit ordered default recommendation sources, not every registered source.
- Persist only public session names and `{messageName, offset}` positions in the browser; never platform cursors or copied page state.
- Consume already archived message pages before fetching another platform page.
- Preserve the current list on load-more failure and expose retry at the tail.
- Restart creates a new generation and resets the anchor; it does not mutate or delete the old session.
- Update counts come from server-side local archive facts, never timers or invented values.
- Continuous feed order is server-published order. Do not reintroduce time or unread sorting into this view; build a separate local archive inbox for those operations.
- A saved session mismatch or missing session is an explicit error. The user can create a new generation with restart; do not silently replace it.
