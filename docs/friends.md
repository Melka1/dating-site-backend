# Friends Model

A symmetric, peer-to-peer affiliation between two users. Distinct from groups (N-way) and from messaging — a friendship is a single mutual link with a request/accept handshake and a parallel one-way block list.

**Scope:** friend-request lifecycle (send / cancel / accept / decline), accepted friendships, unfriend, blocking, friendship visibility on profiles, friends-only discovery surfaces, friend count maintenance, soft moderation / admin overrides. Excludes direct messaging between friends (separate model) and notifications (waits on the Notifications model).

---

## Decisions

| #   | Decision                                                | Note                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Symmetric — one row per pair**                        | `public.friendships(user_low, user_high)` with a CHECK that `user_low < user_high`. Eliminates the (A,B)/(B,A) duplication problem and makes uniqueness a trivial PK rather than a partial index. `requested_by` records direction.                                                  |
| 2   | **Status enum, not separate request/accepted tables**   | `pending → accepted` lifecycle on the same row. Decline / cancel / unfriend hard-delete the row — keeps the table small and avoids tombstones. `blocked` is *not* a friendship status; blocks live in their own directed table.                                                      |
| 3   | **Blocks are a separate directed table**                | `public.user_blocks(blocker_id, blocked_id)`. One-way by nature (A blocks B; B is unaware unless they try to interact). Joining blocks into `friendships` would conflate two different access-control axes.                                                                          |
| 4   | **Block trumps friendship**                             | Inserting a block (either direction) deletes any existing friendship row and any pending request between the two users in the same transaction. Friend requests refuse if a block exists either way.                                                                                 |
| 5   | **Email-verified to send / accept**                     | `@RequireVerified()` route gate, same as groups/profiles. Unverified users may *see* their friend list but cannot send requests, accept, or block.                                                                                                                                  |
| 6   | **`friend_count` denormalised on `public.users`**       | Trigger on `friendships` maintains `users.friend_count`. Powers the `popular` sort already referenced in [user.md](./user.md) and avoids N+1 counts on profile cards.                                                                                                                 |
| 7   | **Self-friendship forbidden at DB + DTO**               | DB CHECK (`user_low <> user_high`) + DTO validator + service-layer guard. Mirrors the 18+ check pattern — three independent layers because the failure mode is silent corruption.                                                                                                    |
| 8   | **Hybrid RLS, same model as users/profiles/groups**     | User-JWT pass-through for reads + self-scoped writes. Service-role for admin actions, block-side-effects, retention, audit, friend-count recompute backfills.                                                                                                                       |
| 9   | **No soft-delete on friendships**                       | Unfriend / decline / cancel are real `DELETE`s. The friend graph is high-churn and there's no retention-grace use case (unlike groups). Audit log captures the act for moderation if needed.                                                                                         |
| 10  | **Rate limit outgoing requests**                        | A user can have at most **50** outstanding `pending` outgoing requests, and at most **100** new requests per rolling 24h. Backend-enforced; not a DB constraint. Prevents spam-friending; tune from real traffic.                                                                    |
| 11  | **Mutuals are computed at query time**                  | No `mutual_count` cache. The two-hop intersection is fast against `friendships_user_low_idx` / `friendships_user_high_idx` for typical friend-list sizes (≤ a few hundred). Revisit only if profile views become hot.                                                                |

---

## Responsibility split

| Concern                                                                                       | Owner                                              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Friendship rows (pair, status, direction, timestamps)                                          | `public.friendships`                              |
| Block rows                                                                                     | `public.user_blocks`                              |
| `users.friend_count` denormalised counter                                                      | `public.users` (trigger-maintained)               |
| Business logic: request lifecycle, block side-effects, rate limits, mutuals, suggestions, search | NestJS backend                                  |
| Audit trail for admin actions                                                                 | `public.audit_log`                                |
| Direct messaging between friends                                                              | Separate model (out of scope)                     |
| Friends-only profile visibility                                                                | `public.profiles.visibility = 'friends'` (joins to `friendships` at read time — to be wired in profiles service) |
| Notifications (request received, accepted)                                                     | Waits on the Notifications model                   |

---

## Entity relationships

```
public.users ─────────► public.friendships ◄───────── public.users
   ▲   ▲                  (user_low, user_high)             ▲   ▲
   │   │                       requested_by ────────────────┘   │
   │   │                                                        │
   │   └────────────► public.user_blocks ◄──────────────────────┘
   │                  (blocker_id, blocked_id)
   │
   └─ users.friend_count ◄── trigger on friendships
```

A friendship row references both users exactly once (sorted). `requested_by` carries the direction. Blocks are independent one-way directed edges that cannot coexist with a friendship between the same pair.

---

## Schema

### `public.friendships`

```sql
create table public.friendships (
  -- Sorted pair — ensures one row per unordered pair.
  user_low  uuid not null references public.users(id) on delete cascade,
  user_high uuid not null references public.users(id) on delete cascade,

  requested_by uuid not null references public.users(id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending','accepted')),

  -- Optional, free-text greeting attached to the request (capped).
  message text check (message is null or char_length(message) <= 280),

  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  primary key (user_low, user_high),

  constraint friendships_sorted check (user_low < user_high),
  constraint friendships_self_forbidden check (user_low <> user_high),
  constraint friendships_requested_by_is_pair check (
    requested_by = user_low or requested_by = user_high
  ),
  constraint friendships_accepted_consistency check (
    (status = 'accepted') = (accepted_at is not null)
  )
);

create index friendships_user_low_idx     on public.friendships (user_low);
create index friendships_user_high_idx    on public.friendships (user_high);
create index friendships_status_idx       on public.friendships (status);
create index friendships_requested_by_idx on public.friendships (requested_by);
create index friendships_accepted_at_idx  on public.friendships (accepted_at desc)
  where status = 'accepted';
```

### `public.user_blocks`

```sql
create table public.user_blocks (
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,

  reason text check (reason is null or char_length(reason) <= 280),
  created_at timestamptz not null default now(),

  primary key (blocker_id, blocked_id),

  constraint user_blocks_self_forbidden check (blocker_id <> blocked_id)
);

create index user_blocks_blocker_idx on public.user_blocks (blocker_id);
create index user_blocks_blocked_idx on public.user_blocks (blocked_id);
```

### `public.users` — additive column

```sql
alter table public.users
  add column friend_count int not null default 0
    check (friend_count >= 0);

create index users_friend_count_idx on public.users (friend_count desc);
```

---

## Triggers

### `friend_count` maintenance

Counts only `accepted` friendships. Each `accepted` row bumps both participants by 1.

```sql
create function public.friendships_recount()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status = 'accepted' then
    update public.users set friend_count = friend_count + 1
      where id in (new.user_low, new.user_high);

  elsif tg_op = 'DELETE' and old.status = 'accepted' then
    update public.users set friend_count = greatest(friend_count - 1, 0)
      where id in (old.user_low, old.user_high);

  elsif tg_op = 'UPDATE' and old.status <> new.status then
    if new.status = 'accepted' then
      update public.users set friend_count = friend_count + 1
        where id in (new.user_low, new.user_high);
    elsif old.status = 'accepted' then
      update public.users set friend_count = greatest(friend_count - 1, 0)
        where id in (old.user_low, old.user_high);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger friendships_recount
  after insert or update or delete on public.friendships
  for each row execute function public.friendships_recount();
```

### `accepted_at` stamp on transition

```sql
create function public.friendships_stamp_accepted()
returns trigger language plpgsql as $$
begin
  if new.status = 'accepted' and (old.status is distinct from 'accepted') then
    new.accepted_at = now();
  elsif new.status <> 'accepted' then
    new.accepted_at = null;
  end if;
  return new;
end;
$$;

create trigger friendships_accepted_stamp
  before update of status on public.friendships
  for each row execute function public.friendships_stamp_accepted();
```

### `updated_at` touch — reuses the shared helper

```sql
create trigger friendships_touch_updated_at
  before update on public.friendships
  for each row execute function public.touch_updated_at();
```

### Block side-effects (service-layer, *not* a trigger)

The cleaner approach is a transactional `BlocksService.block(blockerId, blockedId)` that:

1. Inserts the `user_blocks` row.
2. Deletes the matching `friendships` row (any status, either direction).
3. Audit-logs the cascade.

Done in the backend rather than a trigger because RLS-bypassed cross-table cascade logic is easier to test and review at the service layer. The trigger approach was considered and rejected: it would have to bypass RLS itself and would surprise anyone reading the table definition.

---

## RLS policies

```sql
-- ============ public.friendships ============
alter table public.friendships enable row level security;

-- A user can see any row they are part of.
create policy friendships_select_self on public.friendships
  for select using (
    auth.uid() = user_low or auth.uid() = user_high
  );

-- A user can send a request (insert pending) only as themselves, only on a
-- sorted pair containing themselves, and only if no block exists in either
-- direction. The block check is in service-role land too, but defence in depth.
create policy friendships_insert_self on public.friendships
  for insert with check (
    status = 'pending'
    and requested_by = auth.uid()
    and (auth.uid() = user_low or auth.uid() = user_high)
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = user_low  and b.blocked_id = user_high)
         or (b.blocker_id = user_high and b.blocked_id = user_low)
    )
  );

-- Only the *recipient* (the user who is not requested_by) can accept by flipping
-- to 'accepted'. Re-using the row keeps the PK stable.
create policy friendships_update_accept on public.friendships
  for update using (
    (auth.uid() = user_low or auth.uid() = user_high)
    and auth.uid() <> requested_by
    and status = 'pending'
  )
  with check (
    status = 'accepted'
    and (auth.uid() = user_low or auth.uid() = user_high)
  );

-- Either party can delete (cancel pending / decline / unfriend).
create policy friendships_delete_self on public.friendships
  for delete using (
    auth.uid() = user_low or auth.uid() = user_high
  );

-- ============ public.user_blocks ============
alter table public.user_blocks enable row level security;

-- Only the blocker can see / write / delete their own blocks. The blocked
-- party never observes the row, by design.
create policy user_blocks_select_owner on public.user_blocks
  for select using (blocker_id = auth.uid());

create policy user_blocks_insert_owner on public.user_blocks
  for insert with check (blocker_id = auth.uid());

create policy user_blocks_delete_owner on public.user_blocks
  for delete using (blocker_id = auth.uid());
```

**Hybrid routing:**

| Endpoint                                              | Client                         | RLS? |
| ----------------------------------------------------- | ------------------------------ | ---- |
| `GET /friends`, `/friends/requests/*`, `/friends/:userId` | user JWT                   | yes  |
| `GET /friends/mutual/:userId`                          | user JWT                       | yes  |
| `GET /friends/suggestions`                             | user JWT                       | yes  |
| `POST /friends/requests`                               | user JWT (self-scoped insert)  | yes  |
| `POST /friends/requests/:id/accept`                    | user JWT (RLS allows flip)     | yes  |
| `POST /friends/requests/:id/decline`                   | user JWT (delete own row)      | yes  |
| `DELETE /friends/requests/:id`                         | user JWT (cancel outgoing)     | yes  |
| `DELETE /friends/:userId`                              | user JWT (delete accepted row) | yes  |
| `POST /blocks/:userId`                                 | service role (cascade unfriend) | no  |
| `DELETE /blocks/:userId`                               | user JWT                       | yes  |
| `GET /blocks`                                          | user JWT                       | yes  |
| `/admin/friendships/*`                                 | service role                   | no   |

---

## Request lifecycle

```
                send request                accept
   (no row)  ─────────────────►  pending  ─────────►  accepted
       ▲                            │                     │
       │             decline /      │                     │
       │             cancel         ▼                     │
       └────────────────────────  (row deleted)           │
                                                          │
                                       unfriend           │
                                  ◄───────────────────────┘
```

States:

| Status      | How it gets here                                    | What each side can do                                                          |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| *no row*    | Initial state                                       | Sender: `POST /friends/requests`. Block from either side prevents creation.    |
| `pending`   | Sender created a request                            | Sender: cancel (`DELETE`). Recipient: accept (`POST .../accept`) or decline (`DELETE`). |
| `accepted`  | Recipient accepted                                  | Either party: unfriend (`DELETE`). Block by either party also deletes the row. |

There is no `declined` terminal state — declining hard-deletes the row, freeing the pair to re-request later. Spam mitigations live in the rate limiter, not in tombstones.

---

## Backend endpoints

All routes are versioned under `/api/v1`. All non-`@Public()` routes require auth. `Verified?` marks `@RequireVerified()`.

### Friendship CRUD

| Method | Path                                | Purpose                                                                                                                | Verified? |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| POST   | `/friends/requests`                 | Send a friend request to `targetUserId`. Refuses on existing friendship, existing pending, block in either direction, or rate-limit. | ✅        |
| GET    | `/friends/requests/incoming`        | Pending requests addressed to the caller. Paginated.                                                                    | any       |
| GET    | `/friends/requests/outgoing`        | Pending requests the caller has sent. Paginated.                                                                        | any       |
| POST   | `/friends/requests/:id/accept`      | Recipient accepts. `id` is the friendship row's composite `user_low:user_high` (URL-encoded) or a stable surrogate.      | ✅        |
| POST   | `/friends/requests/:id/decline`     | Recipient declines (row deleted).                                                                                       | ✅        |
| DELETE | `/friends/requests/:id`             | Sender cancels their own outgoing request (row deleted).                                                                | ✅        |
| GET    | `/friends`                          | The caller's accepted friends. Filters: `q` (username/display-name search), `country`, `sort=newest\|name`, pagination. | any       |
| GET    | `/friends/:userId`                  | Friendship state with a specific user: `none\|pending_in\|pending_out\|accepted\|blocked_by_me\|blocked_by_them`.        | any       |
| DELETE | `/friends/:userId`                  | Unfriend an accepted friend (row deleted).                                                                              | ✅        |
| GET    | `/friends/mutual/:userId`           | Mutual friends with `userId`. Paginated; visibility respects each mutual's profile visibility.                          | any       |
| GET    | `/friends/suggestions`              | Suggested users to befriend (FoF + shared interests + same country/city), excluding existing friends/pending/blocked.   | any       |

### Block list

| Method | Path                  | Purpose                                                                                                                                                  | Verified? |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| GET    | `/blocks`             | Users the caller has blocked. Paginated.                                                                                                                  | any       |
| POST   | `/blocks/:userId`     | Block a user. Service-role: also deletes any friendship row and pending request between the two. Audit-logged. Body: `{ reason?: string }`.               | ✅        |
| DELETE | `/blocks/:userId`     | Unblock. Does **not** restore the prior friendship — both parties must re-send a request.                                                                  | ✅        |

### Admin (service role + `@Roles('admin')`)

| Method | Path                                 | Purpose                                                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| GET    | `/admin/friendships`                 | Paginated list with filters (`userId`, `status`, `createdAfter`, `createdBefore`).                     |
| DELETE | `/admin/friendships/:userLow/:userHigh` | Force-delete a friendship row on behalf of moderation. Audit-logged.                                 |
| GET    | `/admin/friendships/flagged`         | Placeholder for the Reports model (parallels `/admin/profiles/flagged`).                               |
| POST   | `/admin/friendships/recount/:userId` | Recompute `users.friend_count` for a user (drift repair). Audit-logged.                                |

All admin writes → `audit_log`.

---

## Algorithms / logic owned by backend

- **Sorted pair construction** — service computes `(user_low, user_high) = userA < userB ? (userA, userB) : (userB, userA)` before every read/write. Single helper, single place.
- **Stable request `id` for URLs** — endpoints accept either `{userLow}:{userHigh}` (URL-encoded colon) **or** the partner's `userId`; service normalises to the sorted pair. We pick `{userLow}:{userHigh}` over a synthetic UUID because the natural PK is already canonical.
- **Block precondition** — before inserting a request, service checks `user_blocks` either way (RLS already enforces this; service raises a clean `409 BLOCKED` rather than a generic policy violation).
- **Block side-effects** — `BlocksService.block` runs in a transaction: insert block → delete friendship (any status) → audit. Uses service-role client to bypass the recipient's RLS.
- **Rate limit on outgoing requests** — service-side; reads from `friendships` (`requested_by = me and status = 'pending'`) and from a rolling 24h window via `created_at`. Returns `429 RATE_LIMITED` with the reset hint.
- **Self-friendship refusal** — service refuses before SQL; DB CHECK is the backstop.
- **Mutual friends query**:
  ```sql
  -- Friends of caller
  with me as (
    select case when user_low = :me then user_high else user_low end as friend_id
    from public.friendships
    where status = 'accepted' and (user_low = :me or user_high = :me)
  ),
  them as (
    select case when user_low = :them then user_high else user_low end as friend_id
    from public.friendships
    where status = 'accepted' and (user_low = :them or user_high = :them)
  )
  select u.id, u.username
    from me join them using (friend_id)
    join public.users u on u.id = friend_id
   where u.account_status = 'active'
   order by u.username
   limit :limit offset :offset;
  ```
  Both CTEs hit `friendships_user_low_idx` / `friendships_user_high_idx`.
- **Friend suggestions** — ordered roughly:
  1. Friends-of-friends not already connected, scored by mutual-count desc.
  2. Same country/city, scored by interest overlap (`profiles.interests && my_interests`).
  3. Recently active (`users.last_active_at desc`).
  Excludes existing friends, outstanding pending requests (either direction), blocked-by-me, blocked-by-them, and `account_status <> 'active'`. Capped at 50 by default, recomputed on each call (no cache for v1).
- **`friend_count` correctness** — trigger maintains it; admin endpoint `/admin/friendships/recount/:userId` rebuilds from scratch for drift repair (rare, but cheap).
- **Friendship audit on admin path only** — user-initiated friend churn is high-volume and not audit-worthy. Admin overrides, blocks, and recount fixes hit `audit_log`.

---

## DTOs (NestJS sketch)

```ts
// send-friend-request.dto.ts
class SendFriendRequestDto {
  @IsUUID('4') targetUserId!: string;
  @IsOptional() @IsString() @MaxLength(280) message?: string;
}

// list-friends.dto.ts
class ListFriendsDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsIn(['newest','name']) sort: 'newest'|'name' = 'newest';
  @IsOptional() @IsInt() @Min(1)            page: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100)  limit: number = 20;
}

// list-requests.dto.ts  — same pagination shape; no filters yet.

// block-user.dto.ts
class BlockUserDto {
  @IsOptional() @IsString() @MaxLength(280) reason?: string;
}

// admin-list-friendships.dto.ts
class AdminListFriendshipsDto {
  @IsOptional() @IsUUID('4') userId?: string;
  @IsOptional() @IsIn(['pending','accepted']) status?: 'pending'|'accepted';
  @IsOptional() @IsISO8601() createdAfter?: string;
  @IsOptional() @IsISO8601() createdBefore?: string;
  @IsOptional() @IsInt() @Min(1)            page: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100)  limit: number = 50;
}
```

---

## Module layout (proposed)

```
src/modules/friends/
  friends.module.ts
  friends.controller.ts          // /friends/* and /friends/requests/*
  friends.service.ts             // request lifecycle, listing, mutuals, suggestions
  blocks.controller.ts           // /blocks/*
  blocks.service.ts              // service-role block cascade
  dto/
    send-friend-request.dto.ts
    list-friends.dto.ts
    list-requests.dto.ts
    block-user.dto.ts
  entities/
    friendship.entity.ts
    user-block.entity.ts

src/modules/admin/
  admin-friendships.controller.ts
```

Follows the same shape as `src/modules/groups/`. `FriendsModule` registers `TypeOrmModule.forFeature([Friendship, UserBlock, User])` and exports `FriendsService` so other modules (profiles, future Messaging) can ask "is X a friend of Y?".

---

## Open items

- **Direct messaging between friends** — out of scope; will reference `friendships` for "you can DM accepted friends only" gating.
- **Notifications** — request received, request accepted, blocked — needs the Notifications model.
- **Friends-only profile visibility** — `profiles.visibility = 'friends'` already exists conceptually in [user.md](./user.md); wiring the friends join is a follow-up in the profiles service once this model lands.
- **Friend suggestions cache** — recompute-on-call for v1. Materialise to a `user_suggestions` table if the suggestions endpoint becomes hot.
- **Mutual count cache** — query-time intersect for v1. Materialise per-pair if profile views become hot.
- **Bulk import** — "find friends from your contact list" needs a separate import + matching pipeline.
- **Soft-blocks / mute** — block is currently binary. A softer "hide from feed but don't sever" needs its own model.
- **Reports model** — `/admin/friendships/flagged` stays empty until report objects exist (same wait as `/admin/profiles/flagged` and `/admin/groups/flagged`).

---

## Phased implementation

Mirrors the rhythm of [groups-implementation-progress.md](./groups-implementation-progress.md). Each phase is shippable on its own.

### Phase 1 — Schema foundation

- Migration `1716000000000-FriendsSchema.ts`:
  - `public.friendships`, `public.user_blocks`, every index.
  - Add `friend_count` column + index to `public.users`.
  - Triggers: `friendships_recount`, `friendships_stamp_accepted`, `friendships_touch_updated_at`.
  - RLS policies on both tables.

### Phase 2 — NestJS scaffold

- Entities `friendship.entity.ts`, `user-block.entity.ts`.
- `FriendsModule` with `TypeOrmModule.forFeature([...])`; wire into [src/app.module.ts](../src/app.module.ts).
- No new env vars expected.

### Phase 3 — Request lifecycle

- `FriendsService.sendRequest` (rate-limited, block-checked, sorted-pair insert).
- `acceptRequest` / `declineRequest` / `cancelRequest`.
- `listIncoming` / `listOutgoing`.
- Controller endpoints under `/friends/requests/*`; `@RequireVerified()` on writes.

### Phase 4 — Friends list + status + unfriend

- `listFriends` with `q`/`country`/`sort` filters.
- `getStatus(userId)` returning the discriminated union.
- `unfriend(userId)`.
- `GET /friends`, `GET /friends/:userId`, `DELETE /friends/:userId`.

### Phase 5 — Blocks

- `BlocksService.block` (transactional cascade) + `unblock` + `listBlocks`.
- Controller `BlocksController` at `/blocks`. Cascade deletion audit-logged.

### Phase 6 — Discovery (mutuals + suggestions)

- `mutualFriends(userId)` — the CTE query above.
- `suggestFriends()` — FoF + interests + locality. Cap 50.
- Endpoints `/friends/mutual/:userId`, `/friends/suggestions`.

### Phase 7 — Admin module

- `admin-friendships.controller.ts` with list / force-delete / recount / flagged.
- All writes → `audit_log`.

### Phase 8 — Tests

- e2e:
  - Send request → recipient accepts → both `users.friend_count` bumped.
  - Decline / cancel / unfriend all hard-delete and restore the counters.
  - Block A→B mid-friendship deletes the row and refuses new requests in either direction.
  - Unblock does NOT restore.
  - Rate limit kicks in at the 51st outstanding pending.
  - Self-friendship blocked at DTO, service, and DB.
  - Mutual friends correctness on a 3-user triangle.
- DB: pgTAP or SQL harness for `friendships_sorted`, `friendships_self_forbidden`, `friendships_requested_by_is_pair`, `friendships_accepted_consistency`, and each RLS policy.
- Unit: `FriendsService`, `BlocksService` with repo + supabase client mocked.

---

## API reference (cookbook)

Base URL: `http://localhost:3000/api/v1`. All routes require `Authorization: Bearer <accessToken>` unless noted. Routes flagged "Verified" need `auth.users.confirmed_at` populated.

### Friend requests

```bash
# Send a request
curl -X POST http://localhost:3000/api/v1/friends/requests \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "targetUserId": "<uuid>", "message": "Hey, met at the coffee meetup" }'

# Incoming pending requests
curl http://localhost:3000/api/v1/friends/requests/incoming \
  -H "Authorization: Bearer $TOKEN"

# Outgoing pending requests
curl http://localhost:3000/api/v1/friends/requests/outgoing \
  -H "Authorization: Bearer $TOKEN"

# Accept (id is "<userLow>:<userHigh>" URL-encoded; backend also accepts the
# partner's userId and normalises)
curl -X POST 'http://localhost:3000/api/v1/friends/requests/<userLow>%3A<userHigh>/accept' \
  -H "Authorization: Bearer $TOKEN"

# Decline
curl -X POST 'http://localhost:3000/api/v1/friends/requests/<userLow>%3A<userHigh>/decline' \
  -H "Authorization: Bearer $TOKEN"

# Cancel my outgoing request
curl -X DELETE 'http://localhost:3000/api/v1/friends/requests/<userLow>%3A<userHigh>' \
  -H "Authorization: Bearer $TOKEN"
```

### Friends list / status

```bash
# My friends (paginated, filterable)
curl -G http://localhost:3000/api/v1/friends \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'q=jane' \
  --data-urlencode 'country=Ethiopia' \
  --data-urlencode 'sort=name' \
  --data-urlencode 'page=1' --data-urlencode 'limit=20'

# Status with a specific user
curl http://localhost:3000/api/v1/friends/<userId> \
  -H "Authorization: Bearer $TOKEN"
# → { "status": "accepted" | "pending_in" | "pending_out" | "none" | "blocked_by_me" | "blocked_by_them" }

# Unfriend
curl -X DELETE http://localhost:3000/api/v1/friends/<userId> \
  -H "Authorization: Bearer $TOKEN"
```

### Mutuals / suggestions

```bash
curl -G http://localhost:3000/api/v1/friends/mutual/<userId> \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'page=1' --data-urlencode 'limit=20'

curl http://localhost:3000/api/v1/friends/suggestions \
  -H "Authorization: Bearer $TOKEN"
```

### Blocks

```bash
# Block — also deletes any existing friendship / pending request both ways
curl -X POST http://localhost:3000/api/v1/blocks/<userId> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "reason": "Repeated unwanted messages" }'

# Unblock (does not restore the prior friendship)
curl -X DELETE http://localhost:3000/api/v1/blocks/<userId> \
  -H "Authorization: Bearer $TOKEN"

# List my blocks
curl http://localhost:3000/api/v1/blocks \
  -H "Authorization: Bearer $TOKEN"
```

### Admin

```bash
# List friendships
curl -G http://localhost:3000/api/v1/admin/friendships \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-urlencode 'userId=<uuid>' \
  --data-urlencode 'status=accepted' \
  --data-urlencode 'createdAfter=2026-01-01' \
  --data-urlencode 'page=1' --data-urlencode 'limit=50'

# Force-delete (moderation override)
curl -X DELETE http://localhost:3000/api/v1/admin/friendships/<userLow>/<userHigh> \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Recount a user's friend_count (drift repair)
curl -X POST http://localhost:3000/api/v1/admin/friendships/recount/<userId> \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Flagged friendships (placeholder until Reports model)
curl http://localhost:3000/api/v1/admin/friendships/flagged \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Route reference at a glance

| Method | Path                                                | Auth   | Gate                                |
| ------ | --------------------------------------------------- | ------ | ----------------------------------- |
| POST   | `/friends/requests`                                 | Bearer | Verified                            |
| GET    | `/friends/requests/incoming`                        | Bearer | —                                   |
| GET    | `/friends/requests/outgoing`                        | Bearer | —                                   |
| POST   | `/friends/requests/:id/accept`                      | Bearer | Verified + recipient                |
| POST   | `/friends/requests/:id/decline`                     | Bearer | Verified + recipient                |
| DELETE | `/friends/requests/:id`                             | Bearer | Verified + sender                   |
| GET    | `/friends`                                          | Bearer | —                                   |
| GET    | `/friends/:userId`                                  | Bearer | —                                   |
| DELETE | `/friends/:userId`                                  | Bearer | Verified                            |
| GET    | `/friends/mutual/:userId`                           | Bearer | —                                   |
| GET    | `/friends/suggestions`                              | Bearer | —                                   |
| GET    | `/blocks`                                           | Bearer | —                                   |
| POST   | `/blocks/:userId`                                   | Bearer | Verified                            |
| DELETE | `/blocks/:userId`                                   | Bearer | Verified                            |
| GET    | `/admin/friendships`                                | Bearer | `role='admin'`                      |
| DELETE | `/admin/friendships/:userLow/:userHigh`             | Bearer | `role='admin'`                      |
| POST   | `/admin/friendships/recount/:userId`                | Bearer | `role='admin'`                      |
| GET    | `/admin/friendships/flagged`                        | Bearer | `role='admin'`                      |
