# Activity (Post + Reaction + Comment + Favorite) Model

Social feed that backs `profile.html` → **Activity** tab. Posts are the unit; the five pill sub-tabs (Personal / Mentions / Favorites / Friends / Groups) are five queries over the same `posts` table.

**Scope:** posts, reactions, comments, favorites, mentions, attachments — everything required to render and interact with the Activity tab and the inline composer.

**Out of scope:** notifications fan-out (separate Notification model), DM threads (Conversation model), blog posts, full-text search/relevance ranking ("Relevant" sort stays a placeholder for v1).

**Dependencies:** Friendship model (for the Friends lens and `audience='friends'` visibility) — already live in this codebase via [`docs/friends.md`](./friends.md). Block model (`user_blocks`) is also live and integrated into the visibility chain.

---

## Decisions

| # | Decision | Note |
|---|---|---|
| 1 | **One `posts` table, lenses are query filters** | The five sub-tabs aren't separate entities — they're `WHERE` clauses (`author_id =`, mention exists, favorite exists, author IN friends, group_id IN my groups). Avoids per-lens denormalization. |
| 2 | **Four audiences, one column** | `audience` text + CHECK: `public` / `friends` / `private` / `group`. `group_id` required iff `audience='group'`, null otherwise (CHECK constraint). |
| 3 | **Attachments are self-contained** | This repo has no Media model, so `post_attachments` carries `url`, `thumbnail_url`, `kind`, `width`, `height`, `display_order` inline. Composer should upload via Supabase storage signed URLs (mirroring the groups avatar/cover pattern) and post the resulting URLs. Migrate to a shared Media table when one lands. |
| 4 | **Soft-delete posts and comments** | `deleted_at` flag preserves reaction/mention/favorite history and downstream counts. Body is replaced with NULL on delete; cards render as "[deleted]". Hard-purged by the retention cron after `softDeleteGraceDays`. |
| 5 | **Mentions extracted server-side** | Body text is canonical; backend parses `@username` on insert/update, resolves to `user_id`, populates `post_mentions`. |
| 6 | **One reaction per user per post** | `reactions` PK = `(post_id, user_id)`. Changing reaction is an UPSERT; type column carries the kind. |
| 7 | **Comments nest via `parent_id`** | Schema supports unbounded depth; UI renders only top-level + one nested row. Deeper replies fetchable via `/comments/:id/replies`. |
| 8 | **Cursor pagination, opaque to frontend** | `cursor = base64url(JSON({createdAt,id}))` for `sort=recent`; `base64url(JSON({score,id}))` for `popular`. |
| 9 | **`PUT` for reactions/favorites, not POST** | Idempotent toggles. Replaying the same request is safe. |
| 10 | **Block model integrated** | `user_blocks` already shipped; the visibility chain excludes posts when either side has blocked the other (both at the RLS layer and in the application query). |

---

## Schema (effective in this codebase)

Differs slightly from the original front-end-suggested schema because this codebase doesn't have a Postgres `enum` for `post_audience` (uses TEXT + CHECK to match the existing `groups`/`friendships` style) and has no `public.media` table yet.

```sql
-- posts
create table public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.users(id) on delete cascade,
  audience    text not null default 'public'
              check (audience in ('public','friends','private','group')),
  group_id    uuid references public.groups(id) on delete cascade,
  body        text,
  edited_at   timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint posts_body_required check (deleted_at is not null or body is not null),
  constraint posts_body_length   check (body is null or char_length(body) between 1 and 5000),
  constraint posts_group_consistency check ((audience = 'group') = (group_id is not null))
);

-- post_attachments (URL-inline; no Media model yet)
create table public.post_attachments (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.posts(id) on delete cascade,
  kind          text not null check (kind in ('photo','video')),
  url           text not null,
  thumbnail_url text,
  width         int  check (width  is null or width  between 1 and 10000),
  height        int  check (height is null or height between 1 and 10000),
  display_order int  not null default 0,
  created_at    timestamptz not null default now()
);

-- post_mentions, reactions, comments, post_favorites: as in spec.
```

See [src/database/migrations/1717000000000-PostsSchema.ts](../src/database/migrations/1717000000000-PostsSchema.ts) for the full migration including indexes, triggers, and RLS policies.

---

## Visibility resolution

Per post, the viewer's effective access is computed in this order. First match wins; otherwise the post is hidden (404 on direct fetch, omitted from feed results).

1. Viewer is the author → visible (incl. deleted, for `/users/me/activity`).
2. Either party has blocked the other → hidden.
3. Post is soft-deleted → hidden (404).
4. `audience='public'` → visible.
5. `audience='group'` → visible iff viewer is an active member of `group_id`.
6. `audience='friends'` → visible iff accepted friendship between author and viewer (using the sorted-pair `user_low/user_high` schema from the Friendship model).
7. `audience='private'` → hidden.

Enforced in two places:
- **RLS** (`posts_select_visible` policy) for any direct table read.
- **Application** (`PostsService.assertVisible` + `applyVisibility` query builder) for batched/joined reads where RLS isn't applied (we connect as the service-role role in NestJS).

---

## Backend endpoints

All write endpoints use `@RequireVerified()`. Read endpoints require auth (provided by the global JWT guard) but no email verification.

Base URL inherits the `api/v1` prefix from `main.ts`.

### Activity feed

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/:userId/activity` | Five-lens feed. Query: `lens` ∈ {`personal`,`mentions`,`favorites`,`friends`,`groups`} (default `personal`), `sort` ∈ {`recent`,`popular`,`relevant`} (default `recent`; `relevant` falls back to `recent` for v1), `cursor`, `limit` (default 20, max 50). |
| GET | `/users/:userId/media` | Gallery of post-attachments authored by the user, visible-to-viewer only. Query: `kind` ∈ {`photo`,`video`} (optional filter), `cursor`, `limit` (default 20, max 50). |
| GET | `/users/me/favorites` | Convenience alias for `lens=favorites`. |

### Posts

| Method | Path | Purpose |
|---|---|---|
| POST | `/posts` | Body: `{ body, audience, groupId?, attachments[]? }`. Backend extracts mentions, validates audience↔group consistency. |
| GET | `/posts/:id` | Single post. Returns full `PostDto`. |
| PATCH | `/posts/:id` | Body: `{ body?, audience? }`. Author only. Re-extracts mentions on body change; cannot move into/out of `group` audience. |
| DELETE | `/posts/:id` | Soft delete. Author or (for group posts) group admin/owner. |

### Reactions, comments, favorites — same as the original spec.

---

## Pagination cursors

- **Recent / lens default:** `base64url(JSON({ createdAt: ISO, id: uuid }))`. Decode and filter `WHERE (created_at, id) < (cursor)`.
- **Popular:** `base64url(JSON({ score: int, id: uuid }))`. Score = `reactions_count + 2 * comments_count` over a rolling 7-day window. Tie-break on `id` desc.

---

## Algorithms

- **Mention extraction.** Regex `/@([a-zA-Z0-9_-]{3,24})/g`. Lookup against `public.users.username` (citext). Insert resolved rows into `post_mentions` (skip self-mentions). Re-runs on edit.
- **Audience validation.** Reject `POST /posts` with `audience='group'` if `groupId` is missing or viewer isn't a member; reject non-group audiences if `groupId` is present.
- **Reaction summary.** Computed per-read from `reactions`. `topActors` = the two most recent unique reactors. No materialized counters yet.
- **Comment count.** `select count(*) from comments where post_id = ? and deleted_at is null` — batched in `countCommentsByPost` for feed responses.
- **Popular sort.** `score = reactions_count + 2 * comments_count` over a 7-day window. Deterministic, so cursors remain stable mid-page.
- **Soft-delete projection.** Setting `deleted_at` nulls the `body`; DTO returns `body: null, isDeleted: true`. Retention cron hard-deletes after `softDeleteGraceDays`.

---

## Open items (carry forward)

- **"Relevant" sort** — placeholder; falls back to recency.
- **Edit window** — currently allow indefinite edits.
- **Edit history** — no `post_revisions` table.
- **Rate-limiting** — none beyond the global `ThrottlerGuard`.
- **Reaction custom types** — six fixed types match the UI icons.
- **Notification fan-out** — mention/reaction/comment notifications belong in the Notification model.
- **Realtime updates** — defer until v1 ships.
- **Media model** — when shared media lands, migrate `post_attachments` to reference it (drop URL columns, add `media_id`).
- **Platform-wide discover feed (`GET /posts`)** — optional. Today browsing is target-scoped via `GET /users/:userId/activity`, which covers the immediate needs. A flat "everything I'm allowed to see" feed would reuse the existing `applyVisibility` + cursor pagination — small lift, mostly UI-driven. Add when the product wants a landing-page feed for guests/members.

---

## API reference (cookbook)

Base URL: `http://localhost:3000/api/v1`. All routes require `Authorization: Bearer <accessToken>`. Routes flagged **Verified** require `auth.users.confirmed_at` populated (enforced by the global `EmailVerifiedGuard`).

UUIDs in the examples (`<postId>`, `<userId>`, `<commentId>`, `<groupId>`) should be replaced with real values. `<cursor>` is the `nextCursor` returned by the previous page (opaque, base64url-encoded JSON).

### Activity feed

```bash
# Personal lens — posts authored by a user (default lens, default sort=recent)
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'lens=personal' \
  --data-urlencode 'sort=recent' \
  --data-urlencode 'limit=20'

# Mentions — posts where the user was @-mentioned
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'lens=mentions'

# Favorites — posts the user bookmarked (only the user themself sees this)
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'lens=favorites'

# Friends — posts authored by the viewer's accepted friends
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'lens=friends'

# Groups — posts in groups the viewer is an active member of
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'lens=groups'

# Popular sort (7-day window, score = reactions + 2*comments)
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'sort=popular'

# Paginate forward — pass nextCursor from the previous page
curl -G http://localhost:3000/api/v1/users/<userId>/activity \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'cursor=<cursor>'

# My favorites — convenience alias for /users/<me>/activity?lens=favorites
curl -G http://localhost:3000/api/v1/users/me/favorites \
  -H "Authorization: Bearer $TOKEN"
```

Response shape:

```json
{
  "items": [
    {
      "id": "...",
      "author": { "userId": "...", "username": "...", "displayName": "...", "avatarUrl": null },
      "audience": "public",
      "group": null,
      "body": "Hello @julia — coffee tomorrow?",
      "attachments": [
        { "id": "...", "kind": "photo", "url": "...", "thumbnailUrl": null,
          "width": 1200, "height": 800, "displayOrder": 0 }
      ],
      "mentions": [{ "userId": "...", "username": "julia" }],
      "reactionSummary": {
        "total": 7,
        "byType": { "like": 5, "heart": 2 },
        "topActors": [{ "userId": "...", "username": "julia", "displayName": "Julia", "avatarUrl": null }],
        "viewerReaction": "like"
      },
      "commentCount": 3,
      "viewerFavorited": false,
      "isDeleted": false,
      "editedAt": null,
      "createdAt": "2026-05-18T10:21:00.000Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMD..."
}
```

### User media (gallery)

Returns every `post_attachment` authored by `:userId` that the viewer is allowed to see. Friends-only posts surface to friends; private posts surface to the author only; group posts only to active group members. Same visibility chain as the activity feed — the gallery is just a different projection of the same row set.

```bash
# All of a user's photos + videos
curl -G http://localhost:3000/api/v1/users/<userId>/media

# Photos only
curl -G http://localhost:3000/api/v1/users/<userId>/media \
  --data-urlencode 'kind=photo'

# Videos only, with pagination
curl -G http://localhost:3000/api/v1/users/<userId>/media \
  --data-urlencode 'kind=video' \
  --data-urlencode 'limit=20'

# As a member — friends-only attachments authored by a friend will appear
curl -G http://localhost:3000/api/v1/users/<userId>/media \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
{
  "items": [
    {
      "attachmentId": "...",
      "postId": "...",
      "kind": "photo",
      "url": "https://.../post/.../abc.jpg",
      "thumbnailUrl": null,
      "width": null,
      "height": null,
      "postCreatedAt": "2026-05-18T10:21:00.000Z"
    }
  ],
  "nextCursor": "eyJwb3N0Q3JlYXRlZE..."
}
```

### Posts CRUD

`POST /posts` is `multipart/form-data`. Text fields (`body`, `audience`, optional `groupId`) ride alongside the `files` field — see [docs/posts.md](./posts.md) for limits (10 MB per photo, 50 MB per video, 10 files max). The backend uploads each file to the `post-media` Supabase bucket and persists the resulting URL in `post_attachments`; no separate signed-URL dance.

```bash
# Create a public post — text only
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -F 'body=Hello @julia — coffee tomorrow?' \
  -F 'audience=public'

# Friends-only post
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -F 'body=Only my friends see this.' \
  -F 'audience=friends'

# Private post (author-only — draft / journal)
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -F 'body=Note to self.' \
  -F 'audience=private'

# Group post — groupId required and audience must be 'group'
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -F 'body=Meetup this Sunday at 10am!' \
  -F 'audience=group' \
  -F 'groupId=<groupId>'

# Post with attachments — repeat the `files` field, displayOrder matches array index
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -F 'body=Some shots from the hike.' \
  -F 'audience=public' \
  -F 'files=@./hike-1.jpg' \
  -F 'files=@./hike-2.jpg' \
  -F 'files=@./hike-clip.mp4'
```

Allowed mime types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/quicktime`, `video/webm`. Anything else → 400. Photos > 10 MB or videos > 50 MB → 413.

```bash
# Get a single post
curl http://localhost:3000/api/v1/posts/<postId> \
  -H "Authorization: Bearer $TOKEN"

# Edit body (author only) — re-extracts mentions, stamps editedAt
curl -X PATCH http://localhost:3000/api/v1/posts/<postId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Updated body — @julia tomorrow at 9 instead." }'

# Change audience between non-group values (public ↔ friends ↔ private)
curl -X PATCH http://localhost:3000/api/v1/posts/<postId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "audience": "friends" }'

# Soft-delete (author or, for group posts, group admin/owner)
curl -X DELETE http://localhost:3000/api/v1/posts/<postId> \
  -H "Authorization: Bearer $TOKEN"
```

### Reactions

```bash
# Like (or change to a different type — same endpoint, idempotent UPSERT)
curl -X PUT http://localhost:3000/api/v1/posts/<postId>/reactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "type": "like" }'

# Switch to heart (same endpoint replaces the previous reaction)
curl -X PUT http://localhost:3000/api/v1/posts/<postId>/reactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "type": "heart" }'

# Remove my reaction
curl -X DELETE http://localhost:3000/api/v1/posts/<postId>/reactions \
  -H "Authorization: Bearer $TOKEN"
```

Allowed types: `like`, `heart`, `laugh`, `wow`, `sad`, `angry`.

### Comments

```bash
# List top-level comments on a post (cursor-paginated)
curl -G http://localhost:3000/api/v1/posts/<postId>/comments \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'limit=20'

# Add a top-level comment
curl -X POST http://localhost:3000/api/v1/posts/<postId>/comments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Count me in!" }'

# Reply to a comment (parentId is the comment to reply to)
curl -X POST http://localhost:3000/api/v1/posts/<postId>/comments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Same here.", "parentId": "<commentId>" }'

# List replies under a comment
curl -G http://localhost:3000/api/v1/comments/<commentId>/replies \
  -H "Authorization: Bearer $TOKEN"

# Edit (author only)
curl -X PATCH http://localhost:3000/api/v1/comments/<commentId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Fixed typo." }'

# Soft-delete (comment author, post author, or group admin/owner for group posts)
curl -X DELETE http://localhost:3000/api/v1/comments/<commentId> \
  -H "Authorization: Bearer $TOKEN"
```

### Favorites (bookmarks)

```bash
# Save a post to my favorites (idempotent)
curl -X PUT http://localhost:3000/api/v1/posts/<postId>/favorite \
  -H "Authorization: Bearer $TOKEN"

# Remove from favorites
curl -X DELETE http://localhost:3000/api/v1/posts/<postId>/favorite \
  -H "Authorization: Bearer $TOKEN"

# List my favorites
curl http://localhost:3000/api/v1/users/me/favorites \
  -H "Authorization: Bearer $TOKEN"
```

### Route reference at a glance

| Method | Path                                  | Auth   | Gate                                                 |
| ------ | ------------------------------------- | ------ | ---------------------------------------------------- |
| GET    | `/users/:userId/activity`             | Optional | Visibility (member-only lenses → 400 for guests)    |
| GET    | `/users/:userId/media`                | Optional | Visibility (per-attachment via parent post)         |
| GET    | `/users/me/favorites`                 | Bearer | —                                                    |
| POST   | `/posts`                              | Bearer | Verified                                             |
| GET    | `/posts/:id`                          | Bearer | Visibility                                           |
| PATCH  | `/posts/:id`                          | Bearer | Verified + author                                    |
| DELETE | `/posts/:id`                          | Bearer | Verified + author or (group post) group admin/owner  |
| PUT    | `/posts/:id/reactions`                | Bearer | Verified + post visible                              |
| DELETE | `/posts/:id/reactions`                | Bearer | Verified                                             |
| GET    | `/posts/:id/comments`                 | Bearer | Visibility                                           |
| POST   | `/posts/:id/comments`                 | Bearer | Verified + post visible                              |
| GET    | `/comments/:id/replies`               | Bearer | Visibility                                           |
| PATCH  | `/comments/:id`                       | Bearer | Verified + comment author                            |
| DELETE | `/comments/:id`                       | Bearer | Verified + comment author, post author, or group admin |
| PUT    | `/posts/:id/favorite`                 | Bearer | Verified + post visible                              |
| DELETE | `/posts/:id/favorite`                 | Bearer | Verified                                             |

> Posts return 404 when the viewer cannot see them (private, blocked, soft-deleted, not in the group, not a friend), so the visibility model is opaque to outsiders — same posture as the groups module.
