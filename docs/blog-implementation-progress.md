# Blog — implementation progress

Tracks the build-out of the plan in [docs/posts.md](./posts.md) (the "BlogPost + BlogComment + Tag Model" section). Phases 1–4 are landed and the build (`npm run build`) is clean. Phase 5 (tests) is the only remaining work.

The blog slice is intentionally separate from the activity Posts slice — different table set (`blog_posts` / `blog_comments`), different audience model (editor-authored + members-only comments), different visibility chain (status-gated, no friend/group fan-out). The frontend wire shape mirrors `CommentDto` to keep the comment client uniform.

> **Body shape.** Body is a `jsonb` array of typed content blocks (`paragraph`, `image`, `quote`, `list` — see [src/modules/blog/blog-blocks.ts](../src/modules/blog/blog-blocks.ts) for the union). Cover is a top-level "image XOR video" pair. Adding a new block type is an additive change: a branch in the union, a case in the validator, a renderer on the frontend.
>
> **Wire format — single-shot multipart.** `POST /blog/posts` and `PATCH /blog/posts/:id` are `multipart/form-data`. One request carries the title/body/tags as text fields, the cover as an optional `cover` file, and body images as repeated `media` files. Inside the JSON-stringified `body` field, image blocks reference uploaded media by zero-based index: `{ "type": "image", "images": [{ "ref": 0 }, { "ref": 2 }] }`. The backend uploads the files, substitutes the refs with the resulting public URLs, validates the resolved body, and persists everything in one transaction. On any failure (validation or DB), the uploaded blobs are best-effort deleted.

---

## Phase 1 — Database

**Done**

- Migration [src/database/migrations/1719000000000-BlogSchema.ts](../src/database/migrations/1719000000000-BlogSchema.ts) provisions:
  - `public.is_editor()` helper — `auth.uid()`'s `users.role IN ('moderator','admin')`. Used by every blog write policy.
  - `public.blog_tags` — slug PK + display name; slug regex + length checks.
  - `public.blog_posts` — `body jsonb` (validated `jsonb_typeof(body) = 'array'` via CHECK), `cover_image_url` / `cover_video_url` with an `xor` CHECK (at most one set), a publish-time CHECK that one of the two is non-null, `(status='published')↔(published_at IS NOT NULL)`, slug regex, title 1–200, excerpt 1–500. Partial indexes for the published list, author dashboard, and deleted-at sweep.
  - `public.blog_post_tags` — composite PK + reverse index on `tag_slug` for "posts in tag" lookups.
  - `public.blog_post_likes` — composite PK `(post_id, user_id)` + reverse index `(user_id, created_at)` for "posts I liked".
  - `public.blog_comments` — self-FK `parent_id`, soft-delete, body length 1–2000, partial indexes on `(post_id, created_at)` where not deleted and `(parent_id)` where set.
  - `touch_updated_at` triggers attached to `blog_posts` and `blog_comments` (reuses the function from `UserProfileSchema`).
- RLS enabled on all five tables:
  - `blog_posts_select_published` — world-readable when `status='published' AND deleted_at IS NULL`.
  - `blog_posts_select_author` — author and editors see drafts/archived/deleted.
  - `blog_posts_write_editor` — `public.is_editor()` + `author_id = auth.uid()` for inserts.
  - `blog_post_tags_*` — read gated by parent-post visibility via `EXISTS`; writes editor-only.
  - `blog_tags_*` — read open; writes editor-only.
  - `blog_post_likes_*` — read gated by post visibility; writes self-only.
  - `blog_comments_*` — read iff parent is published and undeleted; author can see own deleted (for restore UX); editors can update for moderation.

**Remaining**

- Run the migration against the local Supabase instance and against staging.
- Manual in Supabase console: create a Storage bucket named `blog-media` (configurable via `SUPABASE_BLOG_MEDIA_BUCKET`). Reads via the public URL the backend returns; writes blocked at the bucket level so all uploads must go through Nest.

---

## Phase 2 — Module scaffold

**Done**

- Entities at [src/modules/blog/entities/](../src/modules/blog/entities/):
  - [blog-post.entity.ts](../src/modules/blog/entities/blog-post.entity.ts) — `BlogPost` with `BlogPostStatus`, ManyToOne to `User` (RESTRICT to prevent author wipeout), `body: BlogBlock[] | null` (`jsonb`), `coverImageUrl` / `coverVideoUrl` (string XOR pair), OneToMany to comments.
  - [blog-post-tag.entity.ts](../src/modules/blog/entities/blog-post-tag.entity.ts), [blog-post-like.entity.ts](../src/modules/blog/entities/blog-post-like.entity.ts), [blog-tag.entity.ts](../src/modules/blog/entities/blog-tag.entity.ts), [blog-comment.entity.ts](../src/modules/blog/entities/blog-comment.entity.ts).
- [blog.module.ts](../src/modules/blog/blog.module.ts) registers all entities, exports `BlogService` so the retention cron can call into it.
- `BlogModule` imported into [src/app.module.ts](../src/app.module.ts).
- New config plumbed: `SUPABASE_BLOG_MEDIA_BUCKET` (default `blog-media`) in [env.validation.ts](../src/config/env.validation.ts) + [configuration.ts](../src/config/configuration.ts).

---

## Phase 3 — Tags + Posts CRUD

**Done** — [src/modules/blog/blog.service.ts](../src/modules/blog/blog.service.ts) + [blog.controller.ts](../src/modules/blog/blog.controller.ts).

- DTOs at [dto/](../src/modules/blog/dto/):
  - [create-blog-post.dto.ts](../src/modules/blog/dto/create-blog-post.dto.ts) / [update-blog-post.dto.ts](../src/modules/blog/dto/update-blog-post.dto.ts) — multipart text fields. `body` arrives as a JSON string; a `@Transform` parses it before `@IsArray` runs. `tagSlugs` accepts repeated form fields or a comma-joined string.
  - [list-blog-posts.dto.ts](../src/modules/blog/dto/list-blog-posts.dto.ts) — `q`, `tag`, `authorId`, `status`, `type` ∈ {news,story,tips,advice}, `sort` ∈ {recent,popular}, `page`, `limit`.
  - [blog-comment.dto.ts](../src/modules/blog/dto/blog-comment.dto.ts), [blog-tag.dto.ts](../src/modules/blog/dto/blog-tag.dto.ts).
- Helpers:
  - [blog-slug.ts](../src/modules/blog/blog-slug.ts) — `slugify(title)` (NFKD + diacritic strip + lower-kebab) and `normalizeVideoUrl(raw)` (YouTube + Vimeo whitelist, returns the embed-form URL or `null`).
  - [blog-blocks.ts](../src/modules/blog/blog-blocks.ts) — `BlogBlock` union, `validateAndNormalizeBody(raw, uploadedUrls, isOwnBucketUrl)` (validates the structure, resolves `{ ref: N }` against `uploadedUrls`, normalizes everything to the canonical form with explicit `null` for missing optionals), `deriveExcerpt` (first non-empty paragraph/quote clamped to 280 chars), `imageUrlsIn` (powers orphan cleanup on patch).
- **Single-shot multipart upload.** `POST /blog/posts` and `PATCH /blog/posts/:id` accept `multipart/form-data` with:
  - `cover` — one file (optional). Becomes the cover image.
  - `media` — repeated files (optional, up to 20). Body image blocks reference these by `{ ref: N }`.
  - All other fields as text. `body` is a JSON-stringified array of `BlogBlock`s. `coverVideoUrl` is a YouTube/Vimeo URL when the editor wants a video cover instead of an uploaded image; mutually exclusive with `cover`.
- `BlogService.create`:
  - Editor-only (role gate in the service; RLS also enforces).
  - Uploads `cover` then `media` (in order) to `blog-media/<authorId>/blog/{cover|body}/<uuid>.<ext>`. Storage upload happens *outside* the DB transaction so partial failures can't leave a half-open txn.
  - Calls `validateAndNormalizeBody(dto.body, uploadedMediaUrls, …)` — refs in image blocks are substituted with the freshly-uploaded URLs; existing `url`-form items (e.g. when patching) are checked against the blog bucket.
  - Resolves cover: at most one of `coverFile` / `coverVideoUrl` set. Video URLs are normalized to the embed form.
  - Rejects `status='published'` without a cover.
  - Derives `excerpt` from the first paragraph/quote when omitted; trims to 500 chars.
  - Inserts post + `blog_post_tags` rows in a single transaction. Unknown `tagSlug`s auto-create with a humanized display name (`health-care` → `Health Care`) — editors don't need a separate `POST /blog/tags` round-trip for every new label. `PATCH /blog/tags/:slug` is the rename tool when the derived name isn't what you want.
  - Derives a unique slug (`base`, `base-2`, `base-3`, …) with an upper bound of 100 attempts.
  - On any failure (upload error, validation, DB write), best-effort deletes every uploaded blob to avoid orphaning storage.
- `BlogService.patch`:
  - Editor-only. Same upload-first/cleanup-on-failure pattern as create.
  - Body is authoritative — pass the full new array when changing it. Existing items keep `{ url }`; newly uploaded items use `{ ref: N }` against the same request's `media` files. Image URLs that disappear from the new body are best-effort deleted from storage post-commit.
  - Cover updates: upload a new `cover` file → replaces the image, deletes the old blob post-commit. Set `coverVideoUrl=""` to clear video, set it to a YouTube/Vimeo URL to switch to a video cover (auto-deletes the old image blob). Pass `clearCover=true` to wipe both.
  - Tag sync is authoritative replace.
  - Status transition to `published` sets `published_at = now()` (if not already set) and requires a cover.
  - Misuse guard: uploading `media` files without a new `body` to reference them is a 400 (the upload was wasted and gets cleaned up).
- `BlogService.softDelete` — editor-only; nulls `body`, sets `deleted_at`. Cover and body image blobs are retained for the grace window so a restore flow could be added later.
- `BlogService.list`:
  - Filters: `q` (ILIKE on title/excerpt), `tag` (EXISTS join), `authorId`, `status` (editors only — clamped to `published` for everyone else), `type` ∈ {news,story,tips,advice}.
  - Offset pagination (`page`/`limit`, default 12, max 50).
  - `sort='recent'` orders by `(published_at DESC NULLS LAST, created_at DESC)`. `sort='popular'` adds a `popularity_score` subselect (`likes + 2*comments`) inside a 30-day window.
- `BlogService.findBySlug` — returns 404 for non-published posts unless the viewer is the author or an editor.

### Endpoint table

| Method | Path                                | Auth     | Notes |
|---|---|---|---|
| GET    | `/blog/posts`                       | optional | List + filters + sort + offset paging. |
| GET    | `/blog/posts/:slug`                 | optional | 404 on draft/archived unless viewer is author/editor. |
| POST   | `/blog/posts`                       | editor   | **Multipart.** Text fields + `cover` (1) + `media` (≤20). |
| PATCH  | `/blog/posts/:id`                   | editor   | **Multipart.** Partial; same fields. |
| DELETE | `/blog/posts/:id`                   | editor   | Soft delete. 204. |
| PUT    | `/blog/posts/:id/like`              | member   | Idempotent. Returns `{ likeCount, viewerLiked }`. |
| DELETE | `/blog/posts/:id/like`              | member   | Idempotent. Returns `{ likeCount, viewerLiked }`. |
| GET    | `/blog/posts/:id/comments`          | optional | Top-level comments, cursor paged. |
| GET    | `/blog/comments/:id/replies`        | optional | Replies under a top-level comment. |
| POST   | `/blog/posts/:id/comments`          | member   | `{ body, parentId? }`. |
| PATCH  | `/blog/comments/:id`                | author   | Body edit only. |
| DELETE | `/blog/comments/:id`                | author/editor | Soft delete. 204. |
| GET    | `/blog/tags`                        | optional | Full taxonomy. |
| POST   | `/blog/tags`                        | editor   | `{ slug, name }`. |
| PATCH  | `/blog/tags/:slug`                  | editor   | `{ name }`. Slug immutable. |
| DELETE | `/blog/tags/:slug`                  | editor   | Cascades to `blog_post_tags`. 204. |

---

## Phase 4 — Likes, Comments, Retention

**Done** — in `BlogService` and the cron module.

- **Likes** — `INSERT ... ON CONFLICT DO NOTHING` and `DELETE` are both idempotent, both 404 if the post is unpublished or soft-deleted. `BlogPostDto.likeCount` and `BlogPostDto.viewerLiked` are populated on every read.
- **Comments** — write/edit/delete with author + editor authorization. `listTopLevelComments` keyset-paginates `(created_at, id)` to keep mid-page stability. Replies fetched lazily via `/blog/comments/:id/replies`. Soft-delete nulls the body and zeroes the rendered `replyCount`.
- **`commentCount` / `likeCount` rollups** — single-query group-by per request via `countLikesByPost` + `countCommentsByPost`.
- **Retention** — [src/modules/retention/retention.cron.ts](../src/modules/retention/retention.cron.ts) gains `purgeDeletedBlogPosts` at `45 3 * * *` UTC. Reuses the shared `softDeleteGraceDays` config (default 60) so all retention windows stay in sync. `BlogService.purgeExpiredSoftDeleted(graceDays)` does the hard-delete and returns `{ posts, comments }` for audit metadata; FK cascades handle tags/likes/comments.

---

## Phase 5 — Tests (not yet started)

The following suites are still TODO:

- **e2e** — editor creates a post in one multipart request (cover + media files + JSON body with refs) → publishes → member likes + comments → list/detail round-trip.
- **Block validation** — unknown `type` rejected, missing required fields rejected, `paragraph.text > 5000` rejected, `image.images` empty rejected, image URL outside the bucket rejected, `list.style` outside {bulleted,numbered} rejected, `{ url }` + `{ ref }` set together rejected, out-of-range `ref` rejected.
- **Cover XOR** — image-only OK, video-only OK, both → 400, neither when publishing → 400.
- **Single-shot lifecycle** — on validation failure after uploads, the uploaded blobs are deleted; on DB failure, same; on partial multi-file upload failure, `uploadMany`'s own cleanup runs; uploaded `media` with no new `body` referencing them → 400 + cleanup.
- **Visibility matrix** — anonymous / member / editor × draft / published / archived / soft-deleted.
- **Authorship gate** — member `POST /blog/posts` rejected (403); editor accepted.
- **Slug** — collisions suffix correctly (`-2`, `-3`, …); slugify ASCII-folds; `'post'` fallback for non-alphanumeric titles.
- **Video URL whitelist** — YouTube `/watch?v=`, `youtu.be/`, Vimeo `/<id>` and `player.vimeo.com/video/<id>` all normalize to the embed form; arbitrary URLs are rejected.
- **Orphan cleanup** — replacing the body deletes images that no longer appear; replacing the cover image deletes the previous blob; `clearCover` deletes the current image blob.
- **Likes** — PUT idempotent, DELETE idempotent, `viewerLiked` and `likeCount` accurate.
- **Comments** — nested fetch, soft-delete preserves count, author-edit OK / stranger-edit rejected, editor-moderate OK.
- **Tags** — only editors can create/update/delete; deletion cascades to `blog_post_tags`; renaming `name` doesn't change `slug`.
- **Retention** — deleted post returns 404, retained for the grace window, then purged with cascades to tags/likes/comments.

---

## Notable deviations from [docs/posts.md](./posts.md)

1. **Structured body, not HTML.** The spec stores body as sanitized HTML. We store it as a `jsonb` array of typed content blocks (`paragraph`, `image`, `quote`, `list`). Future content types are an additive change: add a branch to the union, a case to the validator, a renderer on the frontend. No `sanitize-html` dependency.
2. **No `format` enum.** The spec's `standard`/`gallery`/`video`/`code` discriminator collapses into the block list (gallery → an image block with N images; code → future block type) plus a top-level cover that is image XOR video. The renderer just walks the block list — no per-post switch.
3. **No `blog_post_media` join table.** Body image URLs live inside the `body` JSON; the validator requires them to come from our own storage bucket so editors can't smuggle in external content.
4. **Single-shot multipart, not the spec's two-phase media flow.** The spec describes `POST /media/upload-url` → `PUT` to Storage → `POST /media/:id/confirm` → `POST /blog/posts {mediaIds}`. We compress all of that into one `multipart/form-data` POST: files travel alongside the text fields, body image blocks reference uploaded files by `{ ref: N }` index, the backend resolves refs to URLs before persisting. One round-trip instead of N+2. When a shared Media model lands, the ref-substitution layer can be replaced by `media_id`s.
5. **`status` stored as TEXT + CHECK** instead of a Postgres enum — matches `posts.audience`, `groups.visibility`, etc. Avoids the extra migration step to evolve status values later.
6. **Retention grace** — uses the shared `retention.softDeleteGraceDays` config (default 60) instead of the spec's fixed 30-day window. Keeps the operator with one knob across users/groups/posts/blog.
7. **No restore endpoint** — soft-delete is editor-only; rows persist for the grace window so a restore flow could be added later, but no public restore route exists yet.
8. **Slug freeze** — enforced by convention in the patch path (no slug-change DTO field; title edits don't re-derive). If editorial later needs an explicit "rename slug" admin endpoint, add a dedicated route and reject when `published_at IS NOT NULL`.

---

## API reference (cookbook)

Base URL: `http://localhost:3000/api/v1`. Bearer-required routes need `Authorization: Bearer <accessToken>`. Routes flagged **Verified** require `auth.users.confirmed_at` populated (enforced by the global `EmailVerifiedGuard`). **Editor** routes additionally require `users.role IN ('moderator','admin')`.

UUIDs in examples (`<postId>`, `<commentId>`) must be replaced with real values. `<slug>` is the human-readable slug returned in `BlogPostDto.slug`. `<cursor>` is the `nextCursor` from the previous comment page (opaque, base64url-encoded JSON).

### Block schema (the `body` field)

Body is an array of typed blocks — pass at least one, at most 100. Image items may carry either a `url` (already-uploaded, e.g. for a patch) **or** a `ref` (zero-based index into the `media` files in the same multipart request).

```ts
type BlogBlock =
  | { type: 'paragraph'; text: string }                            // 1–5000 chars
  | { type: 'image';
      images: (
        | { ref: number; alt?: string|null; caption?: string|null }
        | { url: string; alt?: string|null; caption?: string|null }
      )[] }                                                        // 1–12 images
  | { type: 'quote'; text: string; attribution?: string|null }     // text 1–2000, attribution ≤200
  | { type: 'list'; style: 'bulleted'|'numbered'; items: string[] };  // 1–50 items, each 1–500 chars
```

Photo mimes allowed: `image/jpeg`, `image/png`, `image/webp`, `image/gif`. Cap: 10 MB per file. Anything else → 400 / 413. Up to 20 `media` files per request, plus the single `cover` file.

### Create a post — single-shot multipart

Cover + body images + JSON metadata all in **one request**. The `body` field is a JSON-stringified array; image blocks reference the i-th file in the `media` field with `{ "ref": i }`.

```bash
# Cover image + paragraph + image (one body image) + quote + list
curl -X POST http://localhost:3000/api/v1/blog/posts \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'title=Remote work in 2026' \
  -F 'status=published' \
  -F 'type=story' \
  -F 'tagSlugs=health-care' \
  -F 'tagSlugs=work' \
  -F 'cover=@./cover.jpg' \
  -F 'media=@./office.jpg' \
  -F 'body=[
    { "type": "paragraph", "text": "It has been a strange few years." },
    { "type": "image",
      "images": [{ "ref": 0, "alt": "An empty office", "caption": "Most desks now sit empty four days a week." }]
    },
    { "type": "quote", "text": "Hybrid is the new default.", "attribution": "Gallup, 2026" },
    { "type": "list", "style": "bulleted",
      "items": ["More flexible hours", "Fewer meetings, more async", "Deep-work time is sacred"]
    }
  ]'
```

```bash
# Body with TWO images — refs 0 and 1 map to the two `media` files in upload order
curl -X POST http://localhost:3000/api/v1/blog/posts \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'title=Hiking the Drakensberg' \
  -F 'status=published' \
  -F 'cover=@./cover.jpg' \
  -F 'media=@./trail.jpg' \
  -F 'media=@./summit.jpg' \
  -F 'body=[
    { "type": "paragraph", "text": "Three days, two summits, no signal." },
    { "type": "image", "images": [
        { "ref": 0, "alt": "The trail in", "caption": "Day one, slow start." },
        { "ref": 1, "alt": "Summit photo" }
    ]}
  ]'
```

```bash
# Video cover — YouTube/Vimeo URL, normalized to the embed form. No `cover` file.
curl -X POST http://localhost:3000/api/v1/blog/posts \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'title=Office tour' \
  -F 'status=published' \
  -F 'coverVideoUrl=https://www.youtube.com/watch?v=dQw4w9WgXcQ' \
  -F 'body=[{ "type": "paragraph", "text": "Come take a look." }]'
```

```bash
# Draft — no cover required while draft
curl -X POST http://localhost:3000/api/v1/blog/posts \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'title=Untitled draft' \
  -F 'body=[{ "type": "paragraph", "text": "Working on it…" }]'
```

`cover` (file) and `coverVideoUrl` (text) are mutually exclusive (both → 400). Image refs in the body must map to a `media` file with a matching index — `ref: 3` with only two `media` files → 400 and the uploads are cleaned up.

`type` is optional on create and defaults to `news`. Allowed values: `news`, `story`, `tips`, `advice`.

### Read posts

```bash
# Default — most recent published (page 1, limit 12)
curl http://localhost:3000/api/v1/blog/posts

# Tag / type / search / author / pagination / popular
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'tag=health-care'
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'type=story'
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'q=remote work'
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'authorId=<userId>'
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'sort=popular'
curl -G http://localhost:3000/api/v1/blog/posts --data-urlencode 'page=2' --data-urlencode 'limit=24'

# Editor-only — drafts/archived
curl -G http://localhost:3000/api/v1/blog/posts \
  -H "Authorization: Bearer $EDITOR_TOKEN" --data-urlencode 'status=draft'

# Single post by slug (URL the frontend uses for /blog/posts/:slug)
curl http://localhost:3000/api/v1/blog/posts/remote-work-in-2026

# As a logged-in member — `viewerLiked` populated
curl http://localhost:3000/api/v1/blog/posts/remote-work-in-2026 \
  -H "Authorization: Bearer $TOKEN"
```

Response (single post):

```json
{
  "id": "...",
  "slug": "remote-work-in-2026",
  "title": "Remote work in 2026",
  "excerpt": "It has been a strange few years.",
  "body": [
    { "type": "paragraph", "text": "It has been a strange few years." },
    { "type": "image", "images": [{ "url": "https://…/office.jpg", "alt": "An empty office", "caption": "Most desks now sit empty four days a week." }] },
    { "type": "quote", "text": "Hybrid is the new default.", "attribution": "Gallup, 2026" },
    { "type": "list", "style": "bulleted", "items": ["More flexible hours", "Fewer meetings, more async", "Deep-work time is sacred"] }
  ],
  "author": { "userId": "...", "username": "julia", "displayName": "Julia", "avatarUrl": null },
  "cover": { "imageUrl": "https://…/cover.jpg", "videoUrl": null },
  "tags": [
    { "slug": "health-care", "name": "Health Care" },
    { "slug": "work",        "name": "Work" }
  ],
  "status": "published",
  "type": "story",
  "likeCount": 12,
  "commentCount": 4,
  "viewerLiked": false,
  "publishedAt": "2026-05-12T10:00:00.000Z",
  "editedAt": null,
  "createdAt": "2026-05-12T09:30:00.000Z",
  "updatedAt": "2026-05-12T10:00:00.000Z"
}
```

The persisted body shape only ever has `url` (refs are resolved server-side before save). Drafts / archived / soft-deleted posts return 404 unless the viewer is the author or an editor.

### Edit a post

Partial. Same multipart shape as create. `body` is authoritative — pass the full new array when changing it. Existing images keep `{ url }`; newly uploaded ones use `{ ref: N }`. Mix both freely.

```bash
# Title + tag changes only — no body, no files
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'title=Remote work in 2026 — revised' \
  -F 'tagSlugs=health-care,wellness'

# Swap the cover image — old blob is best-effort deleted from storage after commit
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'cover=@./new-cover.jpg'

# Switch from image-cover to video-cover (old image blob deleted post-commit)
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'coverVideoUrl=https://www.youtube.com/watch?v=dQw4w9WgXcQ'

# Clear the cover entirely (image OR video)
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'clearCover=true'

# Replace the body, KEEPING one existing image (by url) and ADDING one new one (by ref)
# Any images that disappear from the body are deleted from storage post-commit.
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'media=@./new-chart.jpg' \
  -F 'body=[
    { "type": "paragraph", "text": "Updated intro." },
    { "type": "image", "images": [
        { "url": "https://<project>.supabase.co/storage/v1/object/public/blog-media/<editorId>/blog/body/keep-this.jpg", "alt": "Existing chart" },
        { "ref": 0, "alt": "New chart" }
    ]}
  ]'

# Reclassify the post type
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'type=advice'

# Publish a draft — must have a cover by now
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'status=published'

# Archive
curl -X PATCH http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -F 'status=archived'

# Soft-delete (kept for the retention grace window, then hard-deleted by cron)
curl -X DELETE http://localhost:3000/api/v1/blog/posts/<postId> \
  -H "Authorization: Bearer $EDITOR_TOKEN"
```

### Likes

```bash
# Like (idempotent)
curl -X PUT http://localhost:3000/api/v1/blog/posts/<postId>/like \
  -H "Authorization: Bearer $TOKEN"

# Unlike (idempotent)
curl -X DELETE http://localhost:3000/api/v1/blog/posts/<postId>/like \
  -H "Authorization: Bearer $TOKEN"
```

Both return:

```json
{ "likeCount": 13, "viewerLiked": true }
```

### Comments

Members only — every commenter must be authenticated. Lists are open (anyone can read comments on a published post).

```bash
# List top-level comments (cursor-paginated, oldest first)
curl -G http://localhost:3000/api/v1/blog/posts/<postId>/comments \
  --data-urlencode 'limit=20'

# Paginate
curl -G http://localhost:3000/api/v1/blog/posts/<postId>/comments \
  --data-urlencode 'cursor=<cursor>'

# Replies under a comment
curl -G http://localhost:3000/api/v1/blog/comments/<commentId>/replies

# Add a top-level comment
curl -X POST http://localhost:3000/api/v1/blog/posts/<postId>/comments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Great read." }'

# Reply
curl -X POST http://localhost:3000/api/v1/blog/posts/<postId>/comments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "+1 to that.", "parentId": "<commentId>" }'

# Edit (author only)
curl -X PATCH http://localhost:3000/api/v1/blog/comments/<commentId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "body": "Fixed typo." }'

# Soft-delete (comment author OR an editor for moderation)
curl -X DELETE http://localhost:3000/api/v1/blog/comments/<commentId> \
  -H "Authorization: Bearer $TOKEN"
```

A single comment looks like:

```json
{
  "id": "...",
  "postId": "...",
  "parentId": null,
  "author": { "userId": "...", "username": "julia", "displayName": "Julia", "avatarUrl": null },
  "body": "Great read.",
  "replyCount": 0,
  "isDeleted": false,
  "editedAt": null,
  "createdAt": "2026-05-23T10:11:00.000Z"
}
```

### Tags

```bash
# List all tags (open — no auth required)
curl http://localhost:3000/api/v1/blog/tags

# Create (editor only)
curl -X POST http://localhost:3000/api/v1/blog/tags \
  -H "Authorization: Bearer $EDITOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "slug": "health-care", "name": "Health Care" }'

# Rename (slug is immutable — only `name` can change)
curl -X PATCH http://localhost:3000/api/v1/blog/tags/health-care \
  -H "Authorization: Bearer $EDITOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "name": "Healthcare" }'

# Delete — cascades to blog_post_tags (posts stay, tag-rows on them disappear)
curl -X DELETE http://localhost:3000/api/v1/blog/tags/health-care \
  -H "Authorization: Bearer $EDITOR_TOKEN"
```

> **Auto-create on first use.** Unknown `tagSlugs` passed to `POST /blog/posts` or `PATCH /blog/posts/:id` are created automatically with a humanized display name (`health-care` → `Health Care`). Use the explicit `POST /blog/tags` endpoint only when you want to set a non-derived name (e.g. `ai-ml` → `AI/ML`).

### Frontend snippet — composing the request

```ts
const fd = new FormData();
fd.set('title', title);
fd.set('status', 'published');
fd.set('cover', coverFile);            // single File
fd.append('media', officeImage);       // ref = 0
fd.append('media', teamImage);         // ref = 1
fd.set('body', JSON.stringify([
  { type: 'paragraph', text: '...' },
  { type: 'image', images: [{ ref: 0, alt: 'Office' }] },
  { type: 'quote', text: '...', attribution: 'Source' },
  { type: 'image', images: [{ ref: 1, alt: 'Team' }] },
]));
fd.append('tagSlugs', 'health-care');
fd.append('tagSlugs', 'work');

await fetch('/api/v1/blog/posts', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: fd,
});
```

### Route reference at a glance

| Method | Path                              | Auth     | Gate                                          |
| ------ | --------------------------------- | -------- | --------------------------------------------- |
| GET    | `/blog/posts`                     | Optional | Non-editors clamped to `status=published`     |
| GET    | `/blog/posts/:slug`               | Optional | 404 on draft/archived unless author/editor    |
| POST   | `/blog/posts`                     | Bearer   | Verified + editor                             |
| PATCH  | `/blog/posts/:id`                 | Bearer   | Verified + editor                             |
| DELETE | `/blog/posts/:id`                 | Bearer   | Verified + editor                             |
| PUT    | `/blog/posts/:id/like`            | Bearer   | Verified                                      |
| DELETE | `/blog/posts/:id/like`            | Bearer   | Verified                                      |
| GET    | `/blog/posts/:id/comments`        | Optional | —                                             |
| GET    | `/blog/comments/:id/replies`      | Optional | —                                             |
| POST   | `/blog/posts/:id/comments`        | Bearer   | Verified                                      |
| PATCH  | `/blog/comments/:id`              | Bearer   | Verified + comment author                     |
| DELETE | `/blog/comments/:id`              | Bearer   | Verified + comment author or editor           |
| GET    | `/blog/tags`                      | Optional | —                                             |
| POST   | `/blog/tags`                      | Bearer   | Verified + editor                             |
| PATCH  | `/blog/tags/:slug`                | Bearer   | Verified + editor                             |
| DELETE | `/blog/tags/:slug`                | Bearer   | Verified + editor                             |

### Common error responses

| Status | When                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 400    | Block validation failure (unknown `type`, length out of range, `{ url }` outside the bucket, `{ url }` and `{ ref }` both set, `ref` out of bounds), both cover fields set, invalid YouTube/Vimeo URL, body empty, `media` uploaded without a `body` to reference them, `clearCover` combined with a new cover. |
| 401    | Bearer route with no / invalid token.                                                    |
| 403    | Non-editor tries to write a post or tag; non-author tries to edit someone else's comment. |
| 404    | Post not found, soft-deleted, or not visible to the viewer (drafts/archived to outsiders). |
| 409    | Tag slug already exists on create.                                                       |
| 413    | Uploaded image exceeds 10 MB.                                                            |
