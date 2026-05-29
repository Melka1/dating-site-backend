# Groups — implementation progress

Tracks the build-out of the plan in [docs/groups.md](./groups.md). Each phase lists what is already in the repo and what still needs to be wired up. Pick up by working through the **Remaining** list top-down.

Phases 1–9 are now landed. The build (`npx tsc --noEmit`, `npm run build`) is clean. Phase 10 (tests) remains.

---

## Phase 1 — Schema foundation

**Done**

- Migration [src/database/migrations/1715000000000-GroupsSchema.ts](../src/database/migrations/1715000000000-GroupsSchema.ts) provisions `public.groups`, `public.group_members`, every index, the four triggers (`groups_recount_members`, `groups_enforce_single_owner`, `group_members_stamp_joined`, `groups_seed_owner_membership`) + `updated_at` touches, and the RLS policies on both tables. Applied against the local Supabase Postgres.

**Remaining**

- Manual in Supabase console: create Storage buckets `group-avatars` and `group-covers` (private; reads via signed URLs).

## Phase 2 — NestJS scaffold

**Done**

- Entities at [src/modules/groups/entities/](../src/modules/groups/entities/): `group.entity.ts` (with `GroupVisibility`, `GroupJoinPolicy` types), `group-member.entity.ts` (composite PK, `GroupMemberRole`/`GroupMemberStatus` enums).
- [src/modules/groups/groups.module.ts](../src/modules/groups/groups.module.ts) registers `TypeOrmModule.forFeature([Group, GroupMember, User])` and exports `GroupsService` + `TypeOrmModule`.
- `GroupsModule` imported into [src/app.module.ts](../src/app.module.ts).
- `SUPABASE_GROUP_AVATAR_BUCKET` / `SUPABASE_GROUP_COVER_BUCKET` added to `configuration.ts`, `env.validation.ts`, and `.env`.

## Phase 3 — Groups CRUD

**Done** — [src/modules/groups/groups.service.ts](../src/modules/groups/groups.service.ts) + [groups.controller.ts](../src/modules/groups/groups.controller.ts).

- DTOs at [dto/](../src/modules/groups/dto/): `create-group.dto.ts`, `update-group.dto.ts` (`PartialType`), `rename-slug.dto.ts`, `search-groups.dto.ts`, `membership.dto.ts`, `signed-upload.dto.ts` (re-exports the profiles DTO).
- `GroupsService.create` slugifies + reserved-list-checks + insert; trigger seeds owner's `group_members` row.
- `findBySlug`/`listForViewer`/`listMine` enforce visibility (404 on private to non-members).
- `search` uses trigram `name % :q`, GIN overlap on `interests`, country/`join_policy` filters, sort by `newest`/`largest`/`most_active`.
- `patch` admin-or-owner gate; slug changes routed through `renameSlug` (owner-only, reserved-list check).
- `softDelete`/`restore` owner-only, audit-logged.

**Open**

- Slug-rename parked-grace (30 days) not implemented; current `renameSlug` only checks current uniqueness. Re-add when renames start happening in the wild.

## Phase 4 — Membership flows

**Done** — collapsed into [groups.service.ts](../src/modules/groups/groups.service.ts) (no separate `MembershipService` since the boundaries are thin).

- `selfJoin` row-locks the group, asserts `join_policy='open'`, refuses banned members, respects `max_members`.
- `requestJoin` requires `approval`; `cancelRequest` deletes the caller's own pending row.
- `invite` admin-or-owner gate; bulk insert with `In(userIds)` dedup pass; audit-logged.
- `acceptInvite` / `declineInvite` — caller must own the `invited` row.
- `approve` / `deny` — admin/owner gate; audit-logged.
- `leave` — refuses owner with `409 OWNER_CANNOT_LEAVE`.
- All controller endpoints in [groups.controller.ts](../src/modules/groups/groups.controller.ts) under `/groups/:id/{join,join-request,invites,members/...}`, `@RequireVerified()`.

## Phase 5 — Moderation

**Done** in [groups.service.ts](../src/modules/groups/groups.service.ts).

- `setRole` admin-or-owner gate; rejects `owner` role; refuses to change the owner's role; audit-logged.
- `kick`/`ban`/`unban` admin-or-owner gate; refuse to act on the owner; audit-logged.
- `transferOwner` wrapped in a transaction: demote current owner → `admin`, promote target → `owner` (target must already be an active admin). Single-owner trigger is the backstop.

## Phase 6 — Discovery polish

**Remaining** (deferred — needs real traffic to tune)

- Integration tests for `member_count` correctness across every membership transition.
- `EXPLAIN` sanity check on search query against `groups_name_trgm` / `groups_interests_gin`.
- Listing cache layer if the page becomes hot.

## Phase 7 — Media (avatar / cover)

**Done**

- `POST /groups/:id/avatar` + `/cover` on the controller; service builds `group-{avatars,covers}/<groupId>/{avatar,cover}-<ts>.<ext>` paths and returns `{ bucket, path, token, publicUrl }`. Admin-or-owner gate.
- Reuses [profiles/dto/signed-upload.dto.ts](../src/modules/profiles/dto/signed-upload.dto.ts) for mime/size validation.

**Open**

- Same as profiles: `publicUrl` only resolves if the bucket is flipped to public in Studio, or the read path is changed to issue signed read URLs. Hoist a shared `SupabaseStorageService` when this comes up for the second time.

## Phase 8 — Retention

**Done** — [src/modules/retention/retention.cron.ts](../src/modules/retention/retention.cron.ts) gains `purgeDeletedGroups()` at `0 15 3 * * UTC` that hard-deletes groups past `SOFT_DELETE_GRACE_DAYS`. FK cascade clears `group_members`. Each deletion audit-logged.

## Phase 9 — Admin module

**Done** — [src/modules/admin/admin-groups.controller.ts](../src/modules/admin/admin-groups.controller.ts).

- `GET /admin/groups` paginated list with `ownerId`/`includeDeleted`/`suspendedOnly`/`createdAfter`/`createdBefore` filters.
- `POST /admin/groups/:id/suspend` and `/unsuspend` flip `admin_suspended_at` (column added in the migration; both `groupsService.findBySlug` + `listForViewer` filter it out).
- `DELETE /admin/groups/:id` force-soft-delete.
- `GET /admin/groups/flagged` empty placeholder (mirrors `/admin/profiles/flagged`).
- All writes audit-logged.

## Phase 10 — Tests

- e2e (`test/`):
  - Create group → owner row auto-seeded with `role='owner'`, `status='active'`.
  - Open-join, approval flow (request → approve / deny), invite flow (invite → accept / decline).
  - Member-count trigger correctness across every transition.
  - Owner cannot leave / be kicked / be banned / be demoted; transfer-owner is the only escape.
  - Soft-delete hides from `GET /groups`; restore brings it back; retention cron hard-deletes after grace.
  - Visibility: private group returns 404 to non-members.
- DB: pgTAP or SQL harness for RLS policies, `groups_enforce_single_owner`, `groups_recount_members`, `group_members_joined_consistency`.
- Unit: `GroupsService`, `MembershipService` with the supabase client + repo mocked.

---

## What the build looks like right now

- `npx tsc --noEmit -p tsconfig.build.json` → clean.
- `npm run build` → clean.
- `AppModule` imports `GroupsModule`; routes for groups + admin/groups are mapped.
- Local Postgres has `public.groups`, `public.group_members`, the triggers, and the RLS policies applied.

## Open items carried over from docs/groups.md

- Posts / threads inside a group — separate model, blocked on this landing first.
- Notifications model — invite accepted, role change, ban — waits on Notifications work.
- "Groups your friends are in" — waits on Friendship model.
- Reports model — `/admin/groups/flagged` stays empty until report objects exist.
- Geo search radius — country/city exact match for now; PostGIS later if needed.
- Slug rename throttling — proposed 30-day parked-slug window; tune after real renames happen.
