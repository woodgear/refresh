# Followees Progress

## 2026-06-19

- Created implementation goal from grill-me decisions.
- Completion standard:
  - `store/followees-plan.md` documents the agreed plan.
  - Backend has independent `Followee` and `FolloweeWindow` resources.
  - Three platforms have manual followee sync paths and mock coverage.
  - Followee labels, multi-group label semantics, notes, and JSON export work.
  - Frontend has a dedicated Followees page.
  - `verify.sh`, type check, and browser smoke check pass.

## Decisions

- `Followee` is independent from `Author`.
- Unfollowed accounts are retained with `status.following=false`.
- `group` is a special multi-value label stored as a comma-separated token string.
- Notes are overlay annotations under `refresh/note`.
- Export is JSON only, no filters, current-following only.
- Sync uses separate `FolloweeWindow` resources and is manual only for this phase.

## Implementation Log

- Added `Followee` resources and `FolloweeWindow` archives under `data/followee-windows`.
- Added `followees` overlay for user labels and annotations.
- Added manual `POST /api/v1/followeewindows`, `GET/PATCH /api/v1/followees`, `GET /api/v1/followees/export`, and followee window reads.
- Added mock followee fetcher coverage for Zhihu, Twitter, and Bilibili, including complete second sync unfollow marking.
- Added CDP followee fetcher entry points for the three platforms.
- Added dedicated frontend Followees page with platform/group/search filters, sync, JSON export, per-person group/note editing, and batch group assignment.
- Verification:
  - `bunx tsc --noEmit` passed.
  - `./verify.sh` passed with `PASS=99 FAIL=0`.
  - Browser smoke through CDP 9222 passed: Followees page rendered 6 mock followees and saved `group=ai,infra` plus `refresh/note`.
