# Posts — implementation progress

Tracks the build-out of the plan in [docs/posts.md](./posts.md). Each phase lists what is already in the repo and what still needs to be wired up.

Phases 1–6 are landed and the build (`npm run build`) is clean. Phase 7 (tests) remains.

---

## Phase 1 — Database

**Done**

- Migration [src/database/migrations/1717000000000-PostsSchema.ts](../src/database/migrations/1717000000000-PostsSchema.ts) provisions:
  - `public.posts` with audience CHECK, body length CHECK, audience↔group consistency CHECK, and partial indexes on `(author_id, created_at)`, `(group_id, created_at)`, `(public, created_at)`, plus a sparse index on `deleted_at`.
  - `public.post_attachments` — URL-inline (no Media model yet); `kind` ∈ {`photo`,`video`}; index on `(post_id, display_order)`.
  - `public.post_mentions` — composite PK `(post_id, user_id)`; reverse index `(user_id, post_id)`.
  - `public.reactions` — composite PK `(post_id, user_id)`; `type` CHECK; indexes on `(post_id, type)` and `(user_id, created_at)`.
  - `public.comments` — `parent_id` self-FK, soft-delete, body length CHECK; partial indexes on `(post_id, created_at)` where not deleted, `(parent_id)` where not null, and `(author_id, created_at)` where not deleted.
  - `public.post_favorites` — composite PK `(user_id, post_id)`; indexes on `(user_id, created_at)` and `(post_id)`.
  - `touch_updated_at` triggers attached to `public.posts` and `public.comments` (reuses the function defined in `UserProfileSchema`).
- RLS enabled on all six tables with policies that mirror the visibility chain:
  - `posts_select_author` — author always sees own (incl. deleted/private).
  - `posts_select_visible` — others see by audience: public; group (active member); friends (`friendships.status='accepted'` on the sorted pair); and excludes both directions of `user_blocks`.
  - `posts_write_self` — author only.
  - `post_attachments_*` / `post_mentions_select` / `reactions_*` / `comments_*` / `post_favorites_*` — read gated through the parent post via `EXISTS`; writes constrained to the acting user. Mentions are backend-written only (no client INSERT policy).

**Remaining**

- Run the migration against the local Supabase instance and against staging.
- Manual in Supabase console: create a Storage bucket named `post-media` (configurable via `SUPABASE_POST_MEDIA_BUCKET`). Reads via the public URL the backend returns; writes blocked at the bucket level so all uploads must go through Nest.

## Phase 5.5 — Direct multipart uploads

**Done** — landed alongside Phase 5.

- New shared `StorageService` at [src/common/storage/storage.service.ts](../src/modules/../common/storage/storage.service.ts) registered globally via `StorageModule`. Methods: `uploadOne`, `uploadMany` (best-effort cleans up the batch on partial failure), `delete`. Enforces mime whitelist (`image/jpeg|png|webp|gif`, `video/mp4|quicktime|webm`) + size caps (10 MB photo, 50 MB video). Owner id is baked into the storage path (`<userId>/post/<uuid>.<ext>`) so the uploader is verifiable from the URL alone.
- `POST /posts` switched from JSON to `multipart/form-data`. Text fields (`body`, `audience`, `groupId`) ride alongside the `files` field (up to 10 entries via `FilesInterceptor`). `CreatePostAttachmentDto` is gone — clients no longer pass URLs; the backend uploads and persists them in one request.
- `PostsService.create` uploads files first (outside the DB transaction), then opens the transaction for the post + attachment + mention writes. On DB failure, best-effort deletes the uploaded blobs from storage to avoid orphans. `audit.record` runs after commit (matches the post-create fix from earlier).
- `CreatePostDto` simplified to `{ body, audience, groupId? }`.
- New env `SUPABASE_POST_MEDIA_BUCKET` (default `post-media`) in [env.validation.ts](../src/config/env.validation.ts) + [configuration.ts](../src/config/configuration.ts).

**Out of scope (intentional)**
- Profile + group avatar/cover uploads still use the two-step signed-URL flow. Migrating them to the shared `StorageService` is a clean follow-up — same pattern, but it touches working code and was deliberately deferred.
- Width/height extraction. Storing `width`/`height` as `null` for now; if the product needs thumbnails / responsive images, add `sharp` (or equivalent) to the pipeline.
- Thumbnail generation for videos. Same gap.

---

## Phase 2 — NestJS scaffold

**Done**

- Entities at [src/modules/posts/entities/](../src/modules/posts/entities/):
  - [post.entity.ts](../src/modules/posts/entities/post.entity.ts) — `Post` with `PostAudience` type, ManyToOne to `User` and `Group`, OneToMany to attachments/mentions/reactions/comments.
  - [post-attachment.entity.ts](../src/modules/posts/entities/post-attachment.entity.ts) — URL-inline storage, `AttachmentKind` type.
  - [post-mention.entity.ts](../src/modules/posts/entities/post-mention.entity.ts) — composite PK.
  - [reaction.entity.ts](../src/modules/posts/entities/reaction.entity.ts) — `ReactionType` enum, composite PK.
  - [comment.entity.ts](../src/modules/posts/entities/comment.entity.ts) — self-FK on `parent_id`, soft-delete.
  - [post-favorite.entity.ts](../src/modules/posts/entities/post-favorite.entity.ts) — composite PK.
- [posts.module.ts](../src/modules/posts/posts.module.ts) registers all entities plus the cross-module dependencies (`User`, `Group`, `GroupMember`, `Friendship`, `UserBlock`) for visibility joins. Exports `PostsService` so the retention cron can call into it.
- `PostsModule` imported into [src/app.module.ts](../src/app.module.ts).

---

## Phase 3 — Posts CRUD

**Done** — [src/modules/posts/posts.service.ts](../src/modules/posts/posts.service.ts) + [posts.controller.ts](../src/modules/posts/posts.controller.ts).

- DTOs at [dto/](../src/modules/posts/dto/):
  - [create-post.dto.ts](../src/modules/posts/dto/create-post.dto.ts) — `CreatePostDto` and nested `CreatePostAttachmentDto` (max 10 attachments per post).
  - [update-post.dto.ts](../src/modules/posts/dto/update-post.dto.ts) — body/audience patch.
  - [activity-feed.dto.ts](../src/modules/posts/dto/activity-feed.dto.ts) — `lens` / `sort` / `cursor` / `limit`.
  - [reaction.dto.ts](../src/modules/posts/dto/reaction.dto.ts), [comment.dto.ts](../src/modules/posts/dto/comment.dto.ts).
- `PostsService.create` validates audience↔group consistency, asserts group membership when `audience='group'`, inserts post + attachments + mentions inside a single transaction, and emits an audit row.
- `findOne` enforces visibility through `assertVisible` (author shortcut, block check, audience switch).
- `patch` author-only; refuses to move into/out of `group` audience (group_id is immutable post-creation); re-extracts mentions inside a transaction.
- `softDelete` permits the author or (for group posts) a group admin/owner; nulls `body` and sets `deleted_at`.

---

## Phase 4 — Activity feed (lenses + cursor pagination)

**Done** — in [posts.service.ts](../src/modules/posts/posts.service.ts).

- `activityFeed(targetUserId, viewerId, query)` composes:
  - `applyLens` — switches on `lens` to add the lens-specific predicate.
    - `personal`: `p.author_id = targetUserId`.
    - `mentions`: `EXISTS post_mentions`.
    - `favorites`: `EXISTS post_favorites`.
    - `friends`: `EXISTS friendships(status='accepted')` on the sorted pair, using the viewer's id.
    - `groups`: `audience='group' AND EXISTS group_members(active)` for the viewer.
  - `applyVisibility` — appends the same audience-by-viewer predicate as the RLS `posts_select_visible` policy, plus the `user_blocks` exclusion in both directions.
  - `applyRecentSort` / `applyPopularSort` — keyset pagination via `base64url(JSON({...}))` cursors. Popular score = `reactions_count + 2*comments_count` within a 7-day window; cursor includes the score for stable mid-page paging.
- `nextCursor` is computed from the last item of the page (limit+1 sentinel pattern).
- `buildPostDtosBatch` fans out a single round of queries per relation (attachments, mentions, reactions, viewer reaction, viewer favorites, comment counts, authors, groups) and assembles `PostDto`s in memory — no N+1.

---

## Phase 5 — Reactions, comments, favorites

**Done** — in [posts.service.ts](../src/modules/posts/posts.service.ts) and [posts.controller.ts](../src/modules/posts/posts.controller.ts).

- **Reactions:** `PUT /posts/:id/reactions` upserts via `INSERT ... ON CONFLICT (post_id,user_id) DO UPDATE SET type`. `DELETE /posts/:id/reactions` removes. Visibility checked on PUT.
- **Comments:** `POST /posts/:id/comments` (with optional `parentId`), `GET /posts/:id/comments` (top-level only, cursor-paginated), `GET /comments/:id/replies`, `PATCH /comments/:id` (author only), `DELETE /comments/:id` (author / post author / group admin). Soft-delete nulls the body and zeroes the rendered `replyCount`.
- **Favorites:** `PUT /posts/:id/favorite` (idempotent INSERT ... ON CONFLICT DO NOTHING), `DELETE /posts/:id/favorite`, `GET /users/me/favorites` (alias to feed lens=favorites).
- `PostDto.reactionSummary` includes `total`, `byType`, up to 2 `topActors` (most recent unique reactors), and the viewer's reaction.

---

## Phase 6 — Retention sweep

**Done** — [src/modules/retention/retention.cron.ts](../src/modules/retention/retention.cron.ts).

- `RetentionCron.purgeDeletedPosts` runs daily at 03:30 UTC. Hard-deletes posts and comments whose `deleted_at` is older than `softDeleteGraceDays` (shared with users/groups so all soft-delete grace windows stay in sync). FK cascades clean up `post_attachments`, `post_mentions`, `reactions`, `comments`, `post_favorites`.
- `PostsService.purgeExpiredSoftDeleted(graceDays)` does the heavy lifting and returns `{ posts, comments }` for audit-log metadata.
- `RetentionModule` imports `PostsModule` for the service.

---

## Phase 7 — Tests (not yet started)

The following e2e/unit suites are still TODO:

- **CRUD round-trip** per lens (create → react → comment → favorite → feed shows it).
- **Visibility matrix** — author/friend/stranger/group-member × public/friends/private/group, including block exclusion in both directions.
- **Mentions** — insert, edit (add/remove), self-mention skip, unknown username skip, mention regex boundaries.
- **Reactions** — change type idempotent, count rollup accurate, top-actors most-recent-2.
- **Comments** — nested fetch, soft-delete preserves count, author-edit ok / stranger-edit rejected, deleter rules (author / post author / group admin).
- **Soft-delete + retention** — deleted post returns 404 to non-author, retained for grace days, then purged with cascades.
- **Cursor stability** — page through 100 posts, no duplicates, no skips, hot insert mid-page handled.
- **Popular cursor** — score ties broken by `id`, identical scores order deterministically.

---

## Notable deviations from [docs/posts.md](./posts.md)

1. **No `media` table.** The spec described a two-phase Media upload flow (`POST /media/upload-url` → `PUT` to storage → `POST /media/:id/confirm` → use `mediaId` in posts). This repo has no Media model, so `post_attachments` is self-contained (URL/dims inline). When a shared Media model lands, migrate by adding `media_id uuid references public.media(id)` and backfilling.
2. **`audience='friends'` is fully wired** (not deferred). The Friendship model is already shipped in this codebase; the RLS policy and the application-layer visibility join both use the sorted-pair `user_low/user_high` schema rather than `user_a/user_b`.
3. **Block model integrated.** `user_blocks` is part of the visibility chain at both RLS and application layers, even though the original spec listed Block integration as an open item.
4. **`audience` stored as TEXT + CHECK** rather than a Postgres enum, matching the convention in `groups.visibility`, `friendships.status`, `users.account_status`, etc. Avoids the extra migration step to add new audience values later.
5. **No separate `reaction_type` enum either** — TEXT + CHECK, same reason.
6. **Retention grace** — uses the shared `retention.softDeleteGraceDays` config (default 60) instead of a fixed 30-day window. Keeps the operator with one knob.
