# Groups Model

Community subspaces a member can create, discover, join, and post to. Distinct from friendships (1:1) and messaging — a group is an N-way affiliation with shared identity, rules, and a member roster.

**Scope:** group identity, membership lifecycle, roles inside a group, visibility / join policy, discovery, moderation, soft-delete. Excludes posts/threads inside a group (separate model, out of scope here).

---

## Decisions

| #   | Decision                                         | Note                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Slug + display name**                          | `slug` on `public.groups` — URL handle, `citext` unique, `^[a-z0-9-]{3,40}$`. `name` is the human label (1–80 chars, unicode allowed). Renaming `name` is free; `slug` rotates only via explicit rename endpoint to keep external links stable.                                |
| 2   | **Owner is a single user, not a role pool**      | A group has exactly one `owner_id`. Admins are a separate per-membership role. Ownership transfers via an explicit endpoint — prevents the "two owners" race and keeps deletion authority crisp.                                                                              |
| 3   | **Membership is a row, not an array**            | `public.group_members(group_id, user_id, role, status)` rather than `public.groups.member_ids text[]`. Lets a member carry per-group state (role, status, joined_at, invited_by, last_seen_at) and scales to large groups without rewriting a Postgres array on every change. |
| 4   | **Status enum drives invite + approval flow**    | `invited` (someone pending acceptance), `pending` (user requested to join, awaiting approval), `active`, `banned`. One table covers invite-only, request-to-join, and open groups by varying the entry status.                                                                |
| 5   | **Visibility ≠ join policy**                     | `visibility` ∈ `public / unlisted / private` controls who **finds** the group; `join_policy` ∈ `open / approval / invite_only` controls who can **enter**. Independent axes — an unlisted group can still be open-join via direct link.                                       |
| 6   | **Email-verified to join, owner-verified to create** | A `@RequireVerified()` route gate covers both. Mirrors profile/post rules: unverified users can browse but not affiliate.                                                                                                                                                |
| 7   | **Soft-delete a group, not its members**         | `deleted_at` on `public.groups` hides the group everywhere; `group_members` rows are left alone. Retention cron (the same 60-day cron as users) hard-deletes the group row and cascades members.                                                                              |
| 8   | **Member count is denormalised + maintained by trigger** | `public.groups.member_count` is the source of truth for listings; a `group_members` AFTER INSERT/UPDATE/DELETE trigger keeps it correct. Prevents N+1 counts on `/groups` listing pages.                                                                                  |
| 9   | **Interest tags overlap with profile interests** | Reuses the `text[]` interests vocabulary so the same `pg_trgm` / GIN indexes drive both "find groups about X" and "find people interested in X". No separate group-categories table until taxonomy stabilises.                                                                |
| 10  | **Hybrid RLS, same model as users/profiles**     | User-JWT pass-through for reads + self-scoped membership writes. Service-role for owner/admin writes, member-count maintenance, retention, audit.                                                                                                                             |

---

## Responsibility split

| Concern                                                                                       | Owner                                              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Group identity, settings, soft-delete                                                         | `public.groups`                                    |
| Membership rows (role, status, timestamps)                                                    | `public.group_members`                             |
| Business logic: create/update gates, role transitions, approval flow, slug uniqueness, count maintenance, search | NestJS backend                       |
| Group avatar + cover storage                                                                  | Supabase Storage (bucket: `group-avatars`, `group-covers`) |
| Audit trail for admin/moderator actions                                                       | `public.audit_log`                                 |
| Posts / threads / messages inside a group                                                     | Separate model (out of scope)                      |

---

## Entity relationships

```
public.users ────owns────► public.groups
     │                          │
     │                          ├─ avatar_url → Supabase Storage (group-avatars)
     │                          └─ cover_url  → Supabase Storage (group-covers)
     │                          │
     │            N:M           │
     └──────► public.group_members ◄────────┘
                  │
                  └─ invited_by → public.users
```

A user can be in any number of groups; a group has any number of members. The link table carries the per-membership role + status.

---

## Schema

### `public.groups`

```sql
create extension if not exists citext;
create extension if not exists pg_trgm;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  slug citext unique not null
    check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),

  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 2000),
  rules text check (char_length(rules) <= 5000),

  owner_id uuid not null references public.users(id) on delete restrict,

  visibility text not null default 'public'
    check (visibility in ('public','unlisted','private')),
  join_policy text not null default 'open'
    check (join_policy in ('open','approval','invite_only')),

  -- Discovery
  interests text[] not null default '{}',
  country text,
  city text,

  -- Media
  avatar_url text,
  cover_url text,

  -- Soft caps
  max_members int check (max_members is null or max_members between 2 and 100000),

  -- Denormalised; maintained by trigger
  member_count int not null default 0
    check (member_count >= 0),

  -- Lifecycle
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index groups_owner_idx        on public.groups (owner_id);
create index groups_visibility_idx   on public.groups (visibility);
create index groups_join_policy_idx  on public.groups (join_policy);
create index groups_country_idx      on public.groups (country);
create index groups_interests_gin    on public.groups using gin (interests);
create index groups_name_trgm        on public.groups using gin (name gin_trgm_ops);
create index groups_slug_idx         on public.groups (slug);
create index groups_deleted_at_idx   on public.groups (deleted_at)
  where deleted_at is not null;
```

### `public.group_members`

```sql
create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id  uuid not null references public.users(id)  on delete cascade,

  role text not null default 'member'
    check (role in ('member','moderator','admin','owner')),
  status text not null default 'active'
    check (status in ('invited','pending','active','banned')),

  invited_by uuid references public.users(id) on delete set null,
  joined_at timestamptz,                  -- set when status flips to 'active'
  last_seen_at timestamptz,               -- driven by activity inside the group
  banned_until timestamptz,               -- nullable; null = permanent / not-banned
  ban_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (group_id, user_id),

  -- Only one row may carry the synthetic 'owner' role — enforced by trigger
  -- because Postgres has no partial unique constraint with cross-row joins
  -- on this shape without extra plumbing.

  constraint group_members_joined_consistency check (
    (status in ('active','banned')) = (joined_at is not null)
  )
);

create index group_members_group_idx     on public.group_members (group_id);
create index group_members_user_idx      on public.group_members (user_id);
create index group_members_status_idx    on public.group_members (group_id, status);
create index group_members_role_idx      on public.group_members (group_id, role);
create index group_members_invited_by    on public.group_members (invited_by);
```

---

## Triggers

### `member_count` maintenance

```sql
create function public.groups_recount_members()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status = 'active' then
    update public.groups set member_count = member_count + 1 where id = new.group_id;
  elsif tg_op = 'DELETE' and old.status = 'active' then
    update public.groups set member_count = member_count - 1 where id = old.group_id;
  elsif tg_op = 'UPDATE' and old.status <> new.status then
    if new.status = 'active' then
      update public.groups set member_count = member_count + 1 where id = new.group_id;
    elsif old.status = 'active' then
      update public.groups set member_count = member_count - 1 where id = old.group_id;
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger group_members_recount
  after insert or update or delete on public.group_members
  for each row execute function public.groups_recount_members();
```

### Single-owner invariant

```sql
create function public.groups_enforce_single_owner()
returns trigger language plpgsql as $$
begin
  if new.role = 'owner' then
    if exists (
      select 1 from public.group_members
       where group_id = new.group_id
         and role = 'owner'
         and (user_id, group_id) <> (new.user_id, new.group_id)
    ) then
      raise exception 'group % already has an owner', new.group_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger group_members_single_owner
  before insert or update on public.group_members
  for each row execute function public.groups_enforce_single_owner();
```

### `joined_at` on first activation

```sql
create function public.group_members_stamp_joined()
returns trigger language plpgsql as $$
begin
  if new.status in ('active','banned') and old.status not in ('active','banned') then
    new.joined_at = now();
  end if;
  return new;
end;
$$;

create trigger group_members_joined_stamp
  before update of status on public.group_members
  for each row execute function public.group_members_stamp_joined();
```

### `updated_at` touch — same shape as users/profiles

```sql
create trigger groups_touch_updated_at
  before update on public.groups
  for each row execute function public.touch_updated_at();

create trigger group_members_touch_updated_at
  before update on public.group_members
  for each row execute function public.touch_updated_at();
```

### Auto-seed owner row on group create

```sql
create function public.groups_seed_owner_membership()
returns trigger language plpgsql as $$
begin
  insert into public.group_members (group_id, user_id, role, status, joined_at)
  values (new.id, new.owner_id, 'owner', 'active', now());
  return new;
end;
$$;

create trigger groups_after_insert_seed_owner
  after insert on public.groups
  for each row execute function public.groups_seed_owner_membership();
```

---

## RLS policies

```sql
-- ============ public.groups ============
alter table public.groups enable row level security;

-- Discovery: public groups visible to anyone authenticated; unlisted/private
-- only visible to members. Service role bypasses RLS for admin queries.
create policy groups_select on public.groups
  for select using (
    deleted_at is null
    and (
      visibility = 'public'
      or exists (
        select 1 from public.group_members gm
        where gm.group_id = groups.id
          and gm.user_id  = auth.uid()
          and gm.status   = 'active'
      )
    )
  );

create policy groups_insert_self_owner on public.groups
  for insert with check (owner_id = auth.uid());

-- Owner or admin role inside the group can update.
create policy groups_update_owner_or_admin on public.groups
  for update using (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = groups.id
        and gm.user_id  = auth.uid()
        and gm.role     in ('owner','admin')
        and gm.status   = 'active'
    )
  )
  with check (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = groups.id
        and gm.user_id  = auth.uid()
        and gm.role     in ('owner','admin')
        and gm.status   = 'active'
    )
  );

-- Only owner can soft-delete via a status change (or use DELETE; FK cascade
-- would clear members, so prefer the backend soft-delete path).
create policy groups_delete_owner on public.groups
  for delete using (owner_id = auth.uid());

-- ============ public.group_members ============
alter table public.group_members enable row level security;

-- A user can see their own memberships, plus any active membership of a
-- group they are also an active member of (so the roster is visible to peers).
create policy group_members_select on public.group_members
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.group_members gm
      where gm.group_id = group_members.group_id
        and gm.user_id  = auth.uid()
        and gm.status   = 'active'
    )
  );

-- A user can insert *their own* row (self-join), but only for groups that
-- are open-join. Approval / invite-only flows are service-role.
create policy group_members_self_join on public.group_members
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and g.join_policy = 'open'
        and g.deleted_at is null
    )
  );

-- A user can update their own row to leave (status -> 'active' to 'left' is
-- modelled as a DELETE instead — see below) or update last_seen_at.
create policy group_members_update_self on public.group_members
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Leave = delete own row.
create policy group_members_delete_self on public.group_members
  for delete using (user_id = auth.uid());
```

**Hybrid routing:**

| Endpoint                                                     | Client                         | RLS? |
| ------------------------------------------------------------ | ------------------------------ | ---- |
| `GET /groups`, `GET /groups/:slug`, `GET /groups/search`      | user JWT                       | yes  |
| `GET /groups/me` (groups the caller is in)                    | user JWT                       | yes  |
| `POST /groups`                                                | user JWT (owner_id = auth.uid()) | yes  |
| `PATCH /groups/:id`, `DELETE /groups/:id`                     | service role (role-gated)      | no   |
| `POST /groups/:id/join` (open)                                | user JWT                       | yes  |
| `POST /groups/:id/join-request` (approval)                    | service role                   | no   |
| `POST /groups/:id/invites`, `POST /groups/:id/invites/accept` | service role                   | no   |
| `POST /groups/:id/members/:userId/{approve,deny,role,kick,ban}` | service role                   | no   |
| `POST /groups/:id/transfer-owner`                             | service role                   | no   |
| `DELETE /groups/:id/members/me` (leave)                       | user JWT                       | yes  |
| `POST /groups/:id/avatar`, `/cover`                           | service role (signed upload)   | no   |
| `/admin/groups/*`                                             | service role                   | no   |

---

## Membership lifecycle

```
                                     ┌─────────────┐
       owner invites    user requests│              │
        ┌───────────►   ┌────────────► invited /   │
        │               │             │ pending     │
                                     │             │
       open join                     │   ▲   ▲     │
        ┌─────────────────────────────────┘   │     │
        ▼                                     │     │
     active ◄───────────────────────  approve │     │
        │     ▲                       (admin) │     │
   leave│     │  ─── unban (admin)            │     │
   ▼    │     │                               │     │
   (row deleted)                              │     │
        │                                     │     │
        ▼                                     │     │
     banned ────────────────────── deny / kick / ban
```

States:

| Status     | How it gets here                                      | What the user can do                                            |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `invited`  | Admin/owner creates invite (`invite_only`)             | Accept (→ `active`), decline (delete row)                       |
| `pending`  | User requests to join (`approval`)                     | Wait; user may cancel (delete row); admin approves/denies        |
| `active`   | Approved, accepted, or open-joined                     | Read group, post (where supported), leave, see roster            |
| `banned`   | Admin/owner bans                                       | Cannot rejoin until lifted; visible to admins; visible to self  |

Transitions are owned by `GroupsService`; RLS allows the user-driven ones (self-join, leave) and refuses everything else from non-service-role clients.

---

## Backend endpoints

All routes are versioned under `/api/v1`. All non-`@Public()` routes require auth. `Verified?` marks `@RequireVerified()`.

### Groups

| Method | Path                       | Purpose                                                                                                                                | Verified? |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| POST   | `/groups`                  | Create a group. Sets `owner_id = auth.uid()`; trigger seeds the owner's membership row.                                                | ✅        |
| GET    | `/groups`                  | List groups (default: public ones + groups the caller is in). Supports `country`, `interests`, `join_policy`, `q`, `sort`, pagination. | any       |
| GET    | `/groups/me`               | Groups the caller is an `active` member of (incl. owner/admin/moderator/member).                                                       | any       |
| GET    | `/groups/search`           | Trigram search on `name` + GIN overlap on `interests`. Mirrors `/profiles/search` parameter shape.                                     | any       |
| GET    | `/groups/:slug`            | Single group by slug. Hides private groups from non-members.                                                                           | any       |
| PATCH  | `/groups/:id`              | Update name/description/rules/visibility/join_policy/interests/country/city/max_members. Owner or `admin` role.                        | ✅        |
| POST   | `/groups/:id/avatar`       | Signed-upload URL for the group avatar.                                                                                                 | ✅        |
| POST   | `/groups/:id/cover`        | Signed-upload URL for the cover.                                                                                                        | ✅        |
| DELETE | `/groups/:id`              | Soft-delete (sets `deleted_at`); only the owner. Retention cron hard-deletes after 60 days.                                            | ✅        |
| POST   | `/groups/:id/restore`      | Owner re-activates a soft-deleted group within the grace window.                                                                       | ✅        |
| POST   | `/groups/:id/transfer-owner` | Owner promotes a current admin to owner; owner is demoted to admin atomically.                                                       | ✅        |

### Membership

| Method | Path                                       | Purpose                                                                                                       | Verified? |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------- |
| GET    | `/groups/:id/members`                      | Paginated roster. Filters: `status`, `role`. Non-members see only `active` members of public groups.          | any       |
| POST   | `/groups/:id/join`                         | Self-join an `open` group.                                                                                    | ✅        |
| POST   | `/groups/:id/join-request`                 | Request to join an `approval` group → `status='pending'`.                                                     | ✅        |
| POST   | `/groups/:id/join-request/cancel`          | Caller cancels their own `pending` request.                                                                   | ✅        |
| POST   | `/groups/:id/invites`                      | Admin invites a user(s) (by user_id or username). Creates `invited` row(s); audit-logged.                     | ✅        |
| POST   | `/groups/:id/invites/accept`               | Caller (invitee) accepts → `status='active'`.                                                                 | ✅        |
| POST   | `/groups/:id/invites/decline`              | Caller (invitee) declines → row deleted.                                                                      | ✅        |
| POST   | `/groups/:id/members/:userId/approve`      | Admin approves `pending` request → `status='active'`.                                                          | ✅        |
| POST   | `/groups/:id/members/:userId/deny`         | Admin denies `pending` request → row deleted.                                                                  | ✅        |
| POST   | `/groups/:id/members/:userId/role`         | Admin/owner changes a member's `role` (`member`/`moderator`/`admin`). Owner role only via transfer endpoint.   | ✅        |
| POST   | `/groups/:id/members/:userId/kick`         | Admin removes a member (row deleted). Audit-logged.                                                            | ✅        |
| POST   | `/groups/:id/members/:userId/ban`          | Admin bans → `status='banned'`. Body: `{ until?: ISO8601, reason?: string }`. Audit-logged.                    | ✅        |
| POST   | `/groups/:id/members/:userId/unban`        | Admin lifts ban (status → `active`, clears `banned_until`).                                                    | ✅        |
| DELETE | `/groups/:id/members/me`                   | Leave the group. Owner cannot leave without transferring first (409 `OWNER_CANNOT_LEAVE`).                     | ✅        |

### Admin (service role + `@Roles('admin')`)

| Method | Path                                | Purpose                                                                            |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/admin/groups`                     | Paginated list with filters (status, owner, created_at range).                     |
| POST   | `/admin/groups/:id/suspend`         | Sets group to admin-suspended (hidden, no membership writes). Audit-logged.        |
| POST   | `/admin/groups/:id/unsuspend`       | Restores.                                                                          |
| DELETE | `/admin/groups/:id`                 | Force soft-delete on behalf of moderation.                                         |
| GET    | `/admin/groups/flagged`             | Placeholder for the Reports model (parallels `/admin/profiles/flagged`).           |

> Group admin-suspension reuses the soft-delete column with a sibling `admin_suspended_at` field added when this lands — keeps the retention cron logic untouched.

All admin writes → `audit_log`.

---

## Algorithms / logic owned by backend

- **Slug minting** — backend slugifies the submitted `name` (lowercase, dash-collapse, ascii fold), suffixes `-2`, `-3`, … on conflict, validates against the same regex as the DB. Manual rename takes a fresh slug and forbids previously-used slugs from being reclaimed by *other* groups for 30 days (parked-slug grace).
- **Reserved slugs** — `admin`, `api`, `groups`, `me`, `new`, `search`, plus the same reserved list as usernames. Blocked at create + rename.
- **Join policy gate** — `POST /groups/:id/join` only succeeds when `join_policy='open'`. Approval flow routes via `/join-request`; invite-only refuses both unless an `invited` row already exists for the caller.
- **Max-members enforcement** — Backend checks `member_count < max_members` (with a row-lock on the group) before flipping any membership to `active`. Race-safe: `select … for update` inside the transaction.
- **Owner protections** — Owner cannot be kicked, banned, demoted, or have role changed; the only way out is `transfer-owner` (atomic swap with an admin) or group deletion.
- **Single-owner trigger** — Backstop for the application logic. The trigger above raises if a second `owner` row appears; the service layer ensures swaps run inside a transaction so the trigger never fires in the happy path.
- **Member count maintenance** — Trigger on `group_members`. No application-level counts; never trust them as eventually-consistent.
- **Group search** — builds parameterised SQL:
  - `name % :q` (trigram), or `name ilike :q`
  - `interests && :interests` (GIN-indexed overlap)
  - `country = :country`, `join_policy = :join_policy`, `visibility in ('public','unlisted')` (private hidden)
  - Sort: `newest` → `created_at desc`, `largest` → `member_count desc`, `most_active` → recent member activity (later, from `last_seen_at` aggregates).
- **Visibility enforcement** — `GET /groups/:slug` returns 404 (not 403) on a private group the caller isn't in, mirroring profile-visibility behaviour: don't leak existence.
- **Membership audit** — All admin-driven state changes (kick, ban, role, transfer-owner, suspend) write to `audit_log` with `{ groupId, before, after }`.
- **Retention** — Same daily 03:00 UTC cron as users: groups with `deleted_at < now() - 60d` are hard-deleted; FK cascade on `group_members` clears the roster.

---

## DTOs (NestJS sketch)

```ts
// create-group.dto.ts
class CreateGroupDto {
  @IsString() @Length(1, 80)            name!: string;
  @IsOptional() @IsString() @MaxLength(2000)  description?: string;
  @IsOptional() @IsString() @MaxLength(5000)  rules?: string;
  @IsOptional() @IsIn(['public','unlisted','private']) visibility?: GroupVisibility;
  @IsOptional() @IsIn(['open','approval','invite_only']) joinPolicy?: GroupJoinPolicy;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(30) interests?: string[];
  @IsOptional() @IsString() @MaxLength(80)  country?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsInt() @Min(2) @Max(100_000) maxMembers?: number;
}

// update-group.dto.ts  — same fields, all optional; `slug` rename has its own DTO so casual PATCHes don't accidentally cycle URLs.

// search-groups.dto.ts
class SearchGroupsDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) interests?: string[];
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsIn(['open','approval','invite_only']) joinPolicy?: GroupJoinPolicy;
  @IsOptional() @IsIn(['newest','largest','most_active']) sort: GroupSort = 'newest';
  @IsOptional() @IsInt() @Min(1)            page: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100)  limit: number = 20;
}

// invite-members.dto.ts
class InviteMembersDto {
  @IsArray() @ArrayMaxSize(50) @IsUUID('4', { each: true }) userIds!: string[];
}

// set-role.dto.ts
class SetGroupRoleDto {
  @IsIn(['member','moderator','admin']) role!: 'member'|'moderator'|'admin';
}

// ban.dto.ts
class BanMemberDto {
  @IsOptional() @IsISO8601() until?: string;
  @IsOptional() @IsString() @MaxLength(280) reason?: string;
}
```

---

## Open items

- **Posts / threads inside a group** — out of scope here. Will reference `group_id` and respect membership for read/write.
- **Notifications** — invite accepted, request approved/denied, role change, ban — needs a Notifications model (not yet built).
- **Discovery boost** — "groups your friends are in" requires a Friendships model first.
- **Reports model** — `/admin/groups/flagged` stays empty until report objects exist (same wait as `/admin/profiles/flagged`).
- **Public read of group avatars/covers** — buckets default to private; reads go through signed URLs the same way profile media does. Revisit if a CDN is added.
- **Geo search radius** — currently country/city exact match. PostGIS or `earthdistance` if we want "groups within X km".
- **Slug rename throttling** — current proposal is "blocked for 30 days after rename"; tune after real usage.

---

## API reference (cookbook)

Base URL: `http://localhost:3000/api/v1`. All routes require `Authorization: Bearer <accessToken>` unless noted. Routes flagged "Verified" need `auth.users.confirmed_at` populated; the global `EmailVerifiedGuard` enforces it.

### Group CRUD

```bash
# Create — verified caller becomes owner; trigger seeds membership row
curl -X POST http://localhost:3000/api/v1/groups \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "Coffee & Conversation",
    "description": "Slow Sundays, specialty coffee, board games optional.",
    "rules": "Be kind. Show up to the meetups you RSVP to.",
    "visibility": "public",
    "joinPolicy": "open",
    "interests": ["coffee","board_games","hiking"],
    "country": "Ethiopia",
    "city": "Addis Ababa",
    "maxMembers": 200
  }'

# List groups visible to caller (public + groups they're in)
curl -G http://localhost:3000/api/v1/groups \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'q=coffee' \
  --data-urlencode 'interests=coffee,hiking' \
  --data-urlencode 'country=Ethiopia' \
  --data-urlencode 'joinPolicy=open' \
  --data-urlencode 'sort=largest' \
  --data-urlencode 'page=1' --data-urlencode 'limit=20'

# Search — same params as /groups (alias)
curl -G http://localhost:3000/api/v1/groups/search \
  -H "Authorization: Bearer $TOKEN" --data-urlencode 'q=jazz'

# Groups I'm an active member of
curl http://localhost:3000/api/v1/groups/me -H "Authorization: Bearer $TOKEN"

# Get group by slug (404 if private and you're not a member)
curl http://localhost:3000/api/v1/groups/coffee-conversation \
  -H "Authorization: Bearer $TOKEN"

# Update (owner or in-group admin)
curl -X PATCH http://localhost:3000/api/v1/groups/<groupId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "description": "Updated description", "visibility": "unlisted" }'

# Rename slug (owner only)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/slug \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "slug": "coffee-and-talk" }'

# Soft-delete (owner only)
curl -X DELETE http://localhost:3000/api/v1/groups/<groupId> \
  -H "Authorization: Bearer $TOKEN"

# Restore within grace window (owner only)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/restore \
  -H "Authorization: Bearer $TOKEN"

# Transfer ownership — target must already be active 'admin' in the group
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/transfer-owner \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "newOwnerId": "<userUuid>" }'
```

### Media (signed uploads — same two-step flow as profile avatars)

```bash
# Avatar (owner or admin)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/avatar \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "mimeType": "image/jpeg", "size": 204800 }'

# Cover (owner or admin)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/cover \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "mimeType": "image/png", "size": 512000 }'

# Step 2: PUT the binary bytes to the returned signed URL (or use
# supabase.storage.from(bucket).uploadToSignedUrl(path, token, file)).
# Step 3: optionally PATCH /groups/:id with { avatarUrl: <publicUrl> }
# to persist the URL on the row.
```

### Membership — joining

```bash
# Open join (only when joinPolicy='open')
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/join \
  -H "Authorization: Bearer $TOKEN"

# Request to join (only when joinPolicy='approval')
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/join-request \
  -H "Authorization: Bearer $TOKEN"

# Cancel my pending request
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/join-request/cancel \
  -H "Authorization: Bearer $TOKEN"

# Leave (owner can't leave; transfer first)
curl -X DELETE http://localhost:3000/api/v1/groups/<groupId>/members/me \
  -H "Authorization: Bearer $TOKEN"
```

### Membership — invites (admin/owner sends, invitee acts)

```bash
# Send invites (admin or owner) — userIds is an array
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/invites \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "userIds": ["<uuid1>", "<uuid2>"] }'

# Accept my invite
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/invites/accept \
  -H "Authorization: Bearer $TOKEN"

# Decline my invite
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/invites/decline \
  -H "Authorization: Bearer $TOKEN"
```

### Membership — approving requests (admin/owner)

```bash
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/approve \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/deny \
  -H "Authorization: Bearer $TOKEN"
```

### Roster

```bash
# All members of a group (paginated, filterable). Non-members of public/unlisted
# groups only see 'active' rows; private groups return 404 to non-members.
curl -G http://localhost:3000/api/v1/groups/<groupId>/members \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'status=active' \
  --data-urlencode 'role=member'
```

`status` ∈ `invited`, `pending`, `active`, `banned`. `role` ∈ `member`, `moderator`, `admin`, `owner`.

### Moderation (admin/owner)

```bash
# Promote/demote — role is one of member|moderator|admin (owner forbidden — use transfer)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/role \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "role": "moderator" }'

# Kick (deletes the row)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/kick \
  -H "Authorization: Bearer $TOKEN"

# Ban (until + reason both optional)
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/ban \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "until": "2026-12-31T00:00:00Z", "reason": "Repeated rule violations" }'

# Unban
curl -X POST http://localhost:3000/api/v1/groups/<groupId>/members/<userId>/unban \
  -H "Authorization: Bearer $TOKEN"
```

### Admin (global `role='admin'` on `public.users`)

```bash
# Paginated list with filters
curl -G http://localhost:3000/api/v1/admin/groups \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-urlencode 'ownerId=<uuid>' \
  --data-urlencode 'includeDeleted=true' \
  --data-urlencode 'suspendedOnly=false' \
  --data-urlencode 'createdAfter=2026-01-01' \
  --data-urlencode 'createdBefore=2026-12-31' \
  --data-urlencode 'page=1' --data-urlencode 'limit=50'

# Admin suspend (hides from listings + blocks membership writes)
curl -X POST http://localhost:3000/api/v1/admin/groups/<groupId>/suspend \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Lift suspension
curl -X POST http://localhost:3000/api/v1/admin/groups/<groupId>/unsuspend \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Force soft-delete (on behalf of moderation)
curl -X DELETE http://localhost:3000/api/v1/admin/groups/<groupId> \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Flagged groups (placeholder — empty until Reports model lands)
curl http://localhost:3000/api/v1/admin/groups/flagged \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Route reference at a glance

| Method | Path                                            | Auth   | Gate                            |
| ------ | ----------------------------------------------- | ------ | ------------------------------- |
| POST   | `/groups`                                       | Bearer | Verified                        |
| GET    | `/groups`                                       | Bearer | —                               |
| GET    | `/groups/search`                                | Bearer | —                               |
| GET    | `/groups/me`                                    | Bearer | —                               |
| GET    | `/groups/:slug`                                 | Bearer | —                               |
| PATCH  | `/groups/:id`                                   | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/slug`                              | Bearer | Verified + owner                |
| DELETE | `/groups/:id`                                   | Bearer | Verified + owner                |
| POST   | `/groups/:id/restore`                           | Bearer | Verified + owner                |
| POST   | `/groups/:id/transfer-owner`                    | Bearer | Verified + owner                |
| POST   | `/groups/:id/avatar`                            | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/cover`                             | Bearer | Verified + owner/admin          |
| GET    | `/groups/:id/members`                           | Bearer | — (private hides)               |
| POST   | `/groups/:id/join`                              | Bearer | Verified, joinPolicy=open       |
| POST   | `/groups/:id/join-request`                      | Bearer | Verified, joinPolicy=approval   |
| POST   | `/groups/:id/join-request/cancel`               | Bearer | Verified                        |
| POST   | `/groups/:id/invites`                           | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/invites/accept`                    | Bearer | Verified, invitee               |
| POST   | `/groups/:id/invites/decline`                   | Bearer | Verified, invitee               |
| POST   | `/groups/:id/members/:userId/approve`           | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/members/:userId/deny`              | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/members/:userId/role`              | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/members/:userId/kick`              | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/members/:userId/ban`               | Bearer | Verified + owner/admin          |
| POST   | `/groups/:id/members/:userId/unban`             | Bearer | Verified + owner/admin          |
| DELETE | `/groups/:id/members/me`                        | Bearer | Verified, not owner             |
| GET    | `/admin/groups`                                 | Bearer | `role='admin'`                  |
| POST   | `/admin/groups/:id/suspend`                     | Bearer | `role='admin'`                  |
| POST   | `/admin/groups/:id/unsuspend`                   | Bearer | `role='admin'`                  |
| DELETE | `/admin/groups/:id`                             | Bearer | `role='admin'`                  |
| GET    | `/admin/groups/flagged`                         | Bearer | `role='admin'`                  |

> Storage prerequisite: create the `group-avatars` and `group-covers` buckets in Supabase Studio before exercising the media endpoints.
