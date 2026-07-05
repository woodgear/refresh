# Followees Plan

## Goal

Refresh should expose the real list of accounts I follow on Zhihu, Twitter, and Bilibili as first-class API resources. This list is independent from message authors already seen in feed windows.

The feature includes:

- manual sync of the full followee list for all three platforms;
- labels on followees, with `group` as the UI-visible multi-group label;
- user notes on followees;
- JSON export of the currently followed people;
- a dedicated frontend page for browsing, grouping, annotating, syncing, and exporting followees.

## Non-Goals

- Do not infer followees from existing `Author` resources.
- Do not introduce a `Group` resource.
- Do not add CSV export.
- Do not add import.
- Do not add scheduler integration in the first implementation.
- Do not make real platform login state part of automated tests.

## Resource Model

### Followee

`Followee` is a new independent resource:

```json
{
  "apiVersion": "radar/v1",
  "kind": "Followee",
  "metadata": {
    "name": "twitter-123",
    "labels": {
      "platform": "twitter",
      "account": "twitter-main",
      "group": "ai,infra"
    },
    "annotations": {
      "refresh/note": "personal note"
    }
  },
  "spec": {
    "platformId": "123",
    "handle": "alice",
    "displayName": "Alice",
    "avatar": "https://...",
    "url": "https://...",
    "description": "...",
    "raw": {}
  },
  "status": {
    "following": true,
    "firstSeenAt": "2026-06-19T00:00:00.000Z",
    "lastSeenFollowingAt": "2026-06-19T00:00:00.000Z",
    "lastSyncedAt": "2026-06-19T00:00:00.000Z"
  }
}
```

Identity:

- resource name is `<platform>-<platformId>`;
- `platformId` must be the stable platform account id;
- `Author` remains a content-author resource and is not reused for followees.

History:

- followees are not deleted when unfollowed;
- complete sync snapshots mark missing same-platform followees as `status.following=false`;
- incomplete or failed syncs must not mark missing followees as unfollowed.

User state:

- `metadata.labels.group` is a comma-separated token list, such as `ai,infra`;
- `labelSelector=group=ai` means group membership contains `ai`;
- other label selectors remain exact match;
- notes are stored as overlay annotation `refresh/note`;
- platform description and avatar come from synced `spec`.

### FolloweeWindow

Followee sync uses a separate window type instead of `RefreshWindow`, because it represents an account relationship snapshot rather than content fetching.

`FolloweeWindow` records:

- source account/platform;
- trigger, currently only manual;
- sync status;
- whether the snapshot is complete;
- raw followee payloads for traceability.

## Storage

Add followee-specific immutable archives and overlay:

- `data/followee-windows/*.json` stores immutable `FolloweeWindow` files;
- `data/overlay/followees.json` stores followee labels and annotations.

The index rebuilds current `Followee` resources from archived complete snapshots plus overlay. Existing `data/windows` remains content-only.

## API

New endpoints:

```text
GET   /api/v1/followees
GET   /api/v1/followees/{name}
PATCH /api/v1/followees/{name}
POST  /api/v1/followeewindows
GET   /api/v1/followeewindows/{name}
GET   /api/v1/followees/export
```

Behavior:

- `GET /followees` returns a resource list and supports `labelSelector`, `platform`, and default current-only listing.
- `PATCH /followees/{name}` writes only overlay labels and annotations.
- `POST /followeewindows` starts a manual sync for one account or all accounts.
- `GET /followees/export` returns JSON only and includes currently followed people only.
- export shape:

```json
{
  "apiVersion": "radar/v1",
  "kind": "FolloweeExport",
  "exportedAt": "2026-06-19T00:00:00.000Z",
  "count": 1,
  "items": [
    {
      "platform": "twitter",
      "account": "twitter-main",
      "platformId": "123",
      "handle": "alice",
      "displayName": "Alice",
      "avatar": "https://...",
      "url": "https://...",
      "description": "...",
      "group": ["ai", "infra"],
      "labels": { "group": "ai,infra" },
      "note": "personal note"
    }
  ]
}
```

## Fetching

Add per-platform followee list fetchers:

- Zhihu: fetch the logged-in account's following members through the web API or page context.
- Twitter: fetch following users through the logged-in web client GraphQL flow.
- Bilibili: fetch followings through the logged-in web API.

Each fetcher returns:

- normalized followees;
- raw payloads;
- `complete: true` only after pagination reaches the platform's natural end.

Mock fetching must cover all three platforms and include a second sync case where one followee disappears so unfollow marking is tested.

## Frontend

Add a dedicated Followees page.

Page capabilities:

- sync all platforms manually;
- list followees;
- platform filter;
- search by display name, handle, description, or note;
- group filter generated from `labels.group`;
- edit one followee's groups;
- edit one followee's note;
- batch apply groups to selected followees;
- export current followed list as JSON.

Do not add drag-and-drop, group rename UI, CSV, import, or scheduler controls in the first implementation.

## Verification

Automated:

- extend `verify.sh` for `Followee` resources;
- sync mock followees for all three platforms;
- assert current followees list;
- assert `PATCH` labels and `refresh/note`;
- assert `labelSelector=group=x` membership matching;
- assert JSON export contains only `status.following=true`;
- assert a complete second sync marks missing followees as not following;
- run `bunx tsc --noEmit`.

Manual/browser:

- start the local app;
- open the Followees page;
- verify mock-visible list, filters, edit controls, sync action, and JSON export path.

## Implementation Phases

1. Add storage primitives for followee windows and followee overlay.
2. Add normalized followee types and mock/per-platform fetcher interface.
3. Add followee index and selector semantics.
4. Add API endpoints.
5. Add verify coverage.
6. Add frontend API hooks and Followees page.
7. Run verification and record progress.
