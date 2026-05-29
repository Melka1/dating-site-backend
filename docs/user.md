# User + Profile Model

Documented together because they share a lifecycle: created together on signup, updated together during onboarding, cascaded together on delete. Separating them in docs creates duplication and invites drift.

**Scope:** account identity, auth, presence, role/status, deletion lifecycle, dating profile content, onboarding flow, profile search.

---

## Decisions

| #   | Decision                                        | Note                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Username (account) + display name (profile)** | `username` on `public.users` — login handle, `citext` unique, `^[a-zA-Z0-9_-]{3,24}$`. `display_name` on `public.profiles` — what UI shows on cards, headers, DMs. Defaults to `username` at signup, freely editable. Keeps mentions and URLs stable when users rename visually. |
| 2   | **Email verification required**                 | Any write beyond account bootstrap requires `auth.users.email_confirmed_at IS NOT NULL`. Enforced by NestJS `EmailVerifiedGuard`. Unverified users may log in and resend verification; they cannot edit profile, message, upload media, join groups, post, or like.              |
| 3   | **Hybrid RLS**                                  | User-JWT pass-through (RLS active) for reads and self-scoped writes. Service-role (RLS bypassed, backend enforces) for: admin actions, cross-user mutations, presence heartbeat, audit log, retention cron, signup rate-limiting.                                                |
| 4   | **60-day soft delete, then hard delete**        | Flip `account_status = 'deleted'`, `deleted_at = now()`. Login disabled during grace. Restore via signed email link. Daily 03:00 UTC cron hard-deletes `auth.users` rows past 60 days; FK cascades clean everything else.                                                        |
| 5   | **Case-insensitive username via `citext`**      | _(defaulted)_ All equality and unique comparisons just work; no `lower()` index needed.                                                                                                                                                                                          |
| 6   | **18+ enforced at DB + DTO**                    | Dating site — age check is non-negotiable. DB `check` constraint on `dob`, DTO validator, UX blocks onboarding completion.                                                                                                                                                       |
| 7   | **Single trigger creates both rows**            | One `handle_new_user` trigger on `auth.users` creates the matching `public.users` **and** an empty `public.profiles` row in the same transaction. Simpler than a trigger chain.                                                                                                  |

---

## Responsibility split

| Concern                                                                                                                    | Owner                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Email / password / JWT / sessions / email verification                                                                     | Supabase Auth (`auth.users`)                   |
| Account data: username, role, status, presence, onboarding, deletion                                                       | `public.users`                                 |
| Dating content: display name, attributes, bio, location, avatar, cover, visibility                                         | `public.profiles`                              |
| Business logic: signup, verify-gate, presence, onboarding completion, profile search, soft-delete, retention, admin, audit | NestJS backend                                 |
| Avatar / cover file storage                                                                                                | Supabase Storage (bucket: `avatars`, `covers`) |

---

## Entity relationships

```
auth.users (Supabase)
    │ 1:1 (FK cascade delete)
    ▼
public.users ───────1:1───────► public.profiles
    │                               │
    │                               ├─ avatar_url → Supabase Storage
    │                               └─ cover_url  → Supabase Storage
    │
    └─ referenced by every app table (posts, messages, friendships, …)
```

---

## Schema

### `auth.users` — Supabase-managed (do not alter)

- `id` uuid (PK) — FK target for every app table
- `email`, `encrypted_password`, `email_confirmed_at`, `last_sign_in_at`
- `raw_user_meta_data` — carries `username` at signup

### `public.users`

```sql
create extension if not exists citext;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext unique not null,
  role text not null default 'user'
    check (role in ('user','moderator','admin')),
  account_status text not null default 'active'
    check (account_status in ('active','suspended','banned','deleted')),
  is_online boolean not null default false,
  last_active_at timestamptz,
  onboarding_completed boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint users_deleted_at_consistency check (
    (account_status = 'deleted') = (deleted_at is not null)
  )
);

create index users_username_idx       on public.users (username);
create index users_last_active_idx    on public.users (last_active_at desc);
create index users_account_status_idx on public.users (account_status);
create index users_deleted_at_idx     on public.users (deleted_at)
  where account_status = 'deleted';
```

### `public.profiles`

Fields map directly to `profile.html` Profile tab sections and `members.html` filters. Array columns (`text[]`) keep things simple for MVP; split to lookup tables later if needed.

```sql
create extension if not exists pg_trgm;  -- for display_name search

create table public.profiles (
  user_id uuid primary key references public.users(id) on delete cascade,

  -- Base info
  display_name text not null,
  gender text check (gender in
    ('male','female','non_binary','other','prefer_not_to_say')),
  seeking text[] default '{}',            -- can seek multiple genders
  dob date,
  marital_status text check (marital_status in
    ('single','married','divorced','widowed','separated','other')),
  relationship_type text check (relationship_type in
    ('serious','casual','friendship','affair','marriage','open')),

  -- Location
  country text,
  city text,
  address text,

  -- Narrative
  bio text,
  looking_for text,
  likes text,

  -- Lifestyle
  interests text[] default '{}',
  favorite_places text[] default '{}',
  languages text[] default '{}',
  religion text,
  children text check (children in
    ('none','have','want','dont_want','maybe')),
  smoking text check (smoking in
    ('never','casual','regular','trying_to_quit')),
  drinking text check (drinking in
    ('never','socially','regularly')),

  -- Physical
  height_cm int check (height_cm between 100 and 250),
  weight_kg int check (weight_kg between 30 and 300),
  hair_color text,
  eye_color text,
  body_type text,
  ethnicity text,

  -- Profession (used by index.html sidebar filter)
  profession text,

  -- Media
  avatar_url text,
  cover_url text,

  -- Visibility + meta
  visibility text not null default 'public'
    check (visibility in ('public','members_only','private')),
  completion_score int not null default 0
    check (completion_score between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_age_18_plus check (
    dob is null or dob <= current_date - interval '18 years'
  )
);

-- Search / filter indexes (back members.html and profile directory)
create index profiles_gender_idx          on public.profiles (gender);
create index profiles_seeking_gin         on public.profiles using gin (seeking);
create index profiles_interests_gin       on public.profiles using gin (interests);
create index profiles_languages_gin       on public.profiles using gin (languages);
create index profiles_country_idx         on public.profiles (country);
create index profiles_profession_idx      on public.profiles (profession);
create index profiles_dob_idx             on public.profiles (dob);
create index profiles_display_name_trgm   on public.profiles using gin (display_name gin_trgm_ops);
create index profiles_completion_idx      on public.profiles (completion_score desc);
```

---

## Triggers

### Single trigger: create `users` + `profiles` on signup

```sql
create function public.handle_new_user()
returns trigger
language plpgsql
security definer as $$
declare
  v_username text;
begin
  v_username := coalesce(
    new.raw_user_meta_data->>'username',
    split_part(new.email, '@', 1)
  );
  insert into public.users (id, username) values (new.id, v_username);
  insert into public.profiles (user_id, display_name) values (new.id, v_username);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

### `updated_at` touch — apply to both tables

```sql
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
```

### Sync `deleted_at` when status changes

```sql
create function public.sync_deleted_at()
returns trigger language plpgsql as $$
begin
  if new.account_status = 'deleted' and old.account_status <> 'deleted' then
    new.deleted_at = now();
  elsif new.account_status <> 'deleted' and old.account_status = 'deleted' then
    new.deleted_at = null;
  end if;
  return new;
end;
$$;

create trigger users_sync_deleted_at
  before update of account_status on public.users
  for each row execute function public.sync_deleted_at();
```

---

## RLS policies

```sql
-- ============ public.users ============
alter table public.users enable row level security;

create policy users_select_active on public.users
  for select using (account_status = 'active');

create policy users_select_self on public.users
  for select using (auth.uid() = id);

create policy users_update_self on public.users
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============ public.profiles ============
alter table public.profiles enable row level security;

-- Readable if owner is active AND (public OR owner is the viewer)
create policy profiles_select on public.profiles
  for select using (
    user_id = auth.uid()
    or (
      visibility in ('public','members_only')
      and exists (
        select 1 from public.users u
        where u.id = profiles.user_id
          and u.account_status = 'active'
      )
    )
  );

create policy profiles_update_self on public.profiles
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**Hybrid routing:**

| Endpoint                                               | Client                       | RLS? |
| ------------------------------------------------------ | ---------------------------- | ---- |
| `GET /users/me`, `GET /users/:id`, `GET /profiles/:id` | user JWT                     | yes  |
| `PATCH /users/me`, `PATCH /profiles/me`                | user JWT                     | yes  |
| `GET /profiles/search`                                 | user JWT                     | yes  |
| `POST /users/me/presence`                              | service role                 | no   |
| `POST /profiles/me/avatar`, `/cover`                   | service role (signed upload) | no   |
| `DELETE /users/me`, `POST /users/me/restore`           | service role                 | no   |
| `/admin/*`                                             | service role                 | no   |
| Retention cron                                         | service role                 | no   |

Role, `account_status`, `deleted_at`, and `completion_score` are **backend-only** columns — even though RLS allows self-update, DTO whitelists block them from user writes.

---

## Onboarding lifecycle

```
signup (email + password + username)
   │  trigger: creates public.users + empty public.profiles
   ▼
email verification (click link)
   │  auth.users.email_confirmed_at populated
   ▼
onboarding wizard — fill required profile fields
   │  PATCH /profiles/me (multi-step)
   ▼
onboarding_completed flipped true when required fields satisfied
   │  backend validates, not client
   ▼
full member — can browse, message, post, upload
```

**Required fields for `onboarding_completed = true`:** `display_name`, `gender`, `seeking`, `dob` (18+), `country`, `avatar_url`, `bio` (≥ 20 chars). Tune later.

---

## Backend endpoints

### Auth

| Method | Path                        | Purpose                                                        | Verified?  |
| ------ | --------------------------- | -------------------------------------------------------------- | ---------- |
| POST   | `/auth/signup`              | `supabase.auth.signUp` with validated username.                | n/a        |
| POST   | `/auth/login`               | `signInWithPassword`; refuse `deleted` with `ACCOUNT_DELETED`. | n/a        |
| POST   | `/auth/logout`              | Revoke session.                                                | any        |
| POST   | `/auth/refresh`             | Rotate access token.                                           | any        |
| POST   | `/auth/resend-verification` | Trigger new confirmation email (throttled).                    | unverified |

### Users

| Method | Path                 | Purpose                                                          | Verified?   |
| ------ | -------------------- | ---------------------------------------------------------------- | ----------- |
| GET    | `/users/me`          | Full own account row.                                            | any         |
| PATCH  | `/users/me`          | `username`, `onboarding_completed` (backend decides the latter). | ✅          |
| GET    | `/users/:id`         | Public view (hides email, role, status).                         | ✅          |
| POST   | `/users/me/presence` | Heartbeat → `is_online`, `last_active_at`.                       | ✅          |
| DELETE | `/users/me`          | Soft delete + revoke sessions + email restore link.              | ✅          |
| POST   | `/users/me/restore`  | Consume restore token → flip back to `active`.                   | n/a (token) |

### Profiles

| Method | Path                    | Purpose                                                                                                                                                                                                               | Verified? |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| GET    | `/profiles/me`          | Own full profile.                                                                                                                                                                                                     | any       |
| PATCH  | `/profiles/me`          | Update any mutable profile field(s).                                                                                                                                                                                  | ✅        |
| GET    | `/profiles/:user_id`    | View another profile (visibility + block + status).                                                                                                                                                                   | ✅        |
| POST   | `/profiles/me/avatar`   | Upload avatar to Supabase Storage; set `avatar_url`.                                                                                                                                                                  | ✅        |
| POST   | `/profiles/me/cover`    | Upload cover image.                                                                                                                                                                                                   | ✅        |
| GET    | `/profiles/search`      | Directory for `members.html`. Query: `gender`, `seeking[]`, `country`, `age_min`, `age_max`, `profession`, `interests[]`, `q` (display-name trigram), `sort` (newest/oldest/popular/most_active), `page`, `per_page`. | ✅        |
| POST   | `/profiles/me/complete` | Re-evaluate `completion_score` + flip `onboarding_completed` when thresholds met.                                                                                                                                     | ✅        |

### Admin (service role + `@Roles('admin')`)

| Method | Path                                          | Purpose                      |
| ------ | --------------------------------------------- | ---------------------------- |
| POST   | `/admin/users/:id/suspend` / `/ban` / `/role` | Status + role mutations.     |
| GET    | `/admin/users`                                | Paginated list with filters. |
| GET    | `/admin/profiles/flagged`                     | Moderation queue.            |

All admin writes → `audit_log`.

---

## Algorithms / logic owned by backend

- **Email verification gate** — `EmailVerifiedGuard` on every `@RequireVerified()` route; 403 with code `EMAIL_UNVERIFIED` if `email_confirmed_at` is null.
- **Presence** — heartbeat every 30–60s; `@nestjs/schedule` cron runs every minute flipping `is_online = false` after 2 min silence.
- **Username validation** — regex, reserved-word list, profanity filter, citext uniqueness.
- **Display-name validation** — looser than username (allows spaces, unicode, 1–40 chars), profanity filter, no URLs.
- **Age guard** — `dob <= today - 18y` checked in DTO **and** DB constraint; UI shouldn't ever send an under-18 through, but defense-in-depth.
- **Completion score** — weighted sum of filled fields; `POST /profiles/me/complete` recomputes and, if ≥ threshold with required fields set, flips `onboarding_completed = true`.
- **Profile search** — builds parameterised SQL:
  - `gender = :gender`, `country = :country`, `profession = :profession`
  - `seeking && :seeking` and `interests && :interests` (GIN-indexed overlap)
  - `dob between :min_dob and :max_dob` (derive from age range)
  - `display_name ILIKE` or trigram `%` operator for `q`
  - Sort: `newest` → `users.created_at desc`, `most_active` → `users.last_active_at desc`, `popular` → `friend_count desc` (materialized or sub-query)
- **Visibility enforcement** — `GET /profiles/:user_id` respects visibility + block list + `account_status`.
- **Block enforcement** — `GET /users/:id` and `GET /profiles/:id` 404 if viewer is blocked (symmetric; see Block model).
- **Avatar / cover upload** — backend issues a Supabase Storage signed upload URL, client PUTs file, then calls `PATCH /profiles/me` to persist the public URL. Size + mime validated server-side via a pre-signed policy.
- **Soft delete** — `DELETE /users/me` → flip status (trigger stamps `deleted_at`), `supabase.auth.admin.signOut(id)` to kill sessions, email signed restore link (60-day TTL).
- **Login guard** — `deleted` users refused with restore-email hint.
- **Retention cron** — daily at 03:00 UTC: `supabase.auth.admin.deleteUser(id)` for each row with `deleted_at < now() - 60d`. FK cascades handle the rest.
- **Audit log** — every admin action, every soft-delete/restore, every role change.

---

## Implementation plan

### Phase 1 — Supabase foundation

1. Create Supabase project; enable email auth; configure verification + restore email templates; create Storage buckets `avatars` + `covers`.
2. Migration: `citext` + `pg_trgm` extensions, `public.users`, `public.profiles`, all indexes, check constraints.
3. Triggers: `handle_new_user` (creates both rows), `touch_updated_at` (both tables), `sync_deleted_at`.
4. RLS policies on `users` + `profiles`; verify via dashboard (anon reads active, cannot read deleted/private, self-update works, cross-user update blocked).

### Phase 2 — NestJS scaffold

5. `nest new backend`; install `@nestjs/config`, `@nestjs/passport`, `passport-jwt`, `@nestjs/schedule`, `@nestjs/throttler`, `@supabase/supabase-js`, `class-validator`, `class-transformer`.
6. `SupabaseModule` — provides `SupabaseAdminClient` (service role) + request-scoped `SupabaseUserClient` (caller JWT).
7. `AuthModule`: `JwtStrategy` verifies Supabase JWTs against JWKS; attaches `{ id, email, email_confirmed_at, role }` to `request.user`.
8. Guards: `JwtAuthGuard` (global), `RolesGuard` + `@Roles(...)`, **`EmailVerifiedGuard`** + `@RequireVerified()`.
9. Global `ValidationPipe` (whitelist + transform), uniform error filter, request-id + logging interceptor, `ThrottlerModule`.

### Phase 3 — Auth module

10. `POST /auth/signup` → validate username, uniqueness pre-check, `signUp` with `username` in `raw_user_meta_data`.
11. `POST /auth/login` → reject `deleted`, succeed otherwise.
12. `/auth/logout`, `/auth/refresh`, `/auth/resend-verification` (throttled).

### Phase 4 — Users module

13. `UsersController` + `UsersService`: `/users/me` (GET/PATCH), `/users/:id`, `/users/me/presence`.
14. Presence cron (every minute) flipping stale users offline.

### Phase 5 — Profiles module

15. `ProfilesController` + `ProfilesService` + `ProfilesRepository`.
16. `/profiles/me` (GET/PATCH), `/profiles/:user_id` with visibility + block enforcement.
17. `/profiles/me/avatar`, `/cover` — signed Storage upload flow.
18. `/profiles/search` — parameterised query builder; pagination via cursor or `limit/offset`.
19. `/profiles/me/complete` — completion score + onboarding flip.

### Phase 6 — Deletion + restoration

20. `DELETE /users/me`: flip status, revoke sessions, email signed restore token.
21. `POST /users/me/restore`: verify token, flip back to active.
22. Retention cron (`@Cron('0 3 * * *')`): hard-delete past 60-day grace.

### Phase 7 — Admin module

23. `AdminUsersController` with `RolesGuard` + `@Roles('admin')`: suspend, ban, set role, list.
24. Moderation queue for flagged profiles.
25. Every write → `audit_log`.

### Phase 8 — Frontend wiring

26. `signup.html` → `/auth/signup` (fields at `signup.html:155–164`).
27. `login.html` → `/auth/login`; surface `ACCOUNT_DELETED` + verification errors.
28. Verification banner + resend control when `email_confirmed_at` is null.
29. Onboarding wizard (multi-step, hitting `PATCH /profiles/me`, finishing with `/profiles/me/complete`).
30. `profile.html` Profile tab ← `GET /profiles/me` or `/profiles/:id`; edit forms → `PATCH /profiles/me`.
31. `members.html` ← `GET /profiles/search` with all filters + sort.
32. Presence heartbeat; auth guard on authenticated pages.
33. Logout + "Delete account" control.

### Phase 9 — Tests

34. **e2e (Jest + supertest)**: signup → verify → login → onboard → search; verified-only endpoints 403 for unverified; deleted user cannot log in; restore flow round-trip; profile search returns expected slice given fixture data.
35. **DB (pgTAP / Supabase harness)**: RLS on both tables (anon reads active public, cannot read deleted/private, self-update works, cross-user blocked); `handle_new_user` creates both rows; `sync_deleted_at` toggles correctly; age constraint rejects under-18; `users_deleted_at_consistency` rejects inconsistent states.
36. Retention cron: create deleted user with `deleted_at < now() - 61d`, run cron, assert row gone.
37. Presence cron flips `is_online` after threshold.
38. Admin routes: 403 for plain user, 200 + audit row for admin.

---

## Remaining open items

- **Restore-token format** — backend-signed JWT vs. Supabase magic-link with a `restore` claim?
- **Deletion side-effects on content** — when a user is soft-deleted, do their posts/messages stay visible attributed to "deleted user", or hide immediately? Default proposal: hide content from `account_status IN ('deleted','banned')` via join filter; confirm in each downstream model doc.
- **Profile visibility: members_only vs public** — same behavior in MVP; real split only matters if we allow anonymous browsing for SEO.
- **Friends-only visibility** — not included; requires Friendship model first. Add when that model lands.
- **Grace-period reminders** — T-7d / T-1d emails before hard delete. Nice-to-have.
- **Required onboarding fields** — proposed set listed above; confirm or tune.
- **Profession**: free text vs. curated list? Free text is simpler but dirties the filter. Could start free-text, add autocomplete + canonical list later.

---

## API reference (cookbook)

Base URL: `http://localhost:3000/api/v1`. All routes require `Authorization: Bearer <accessToken>` unless flagged `@Public()`. Routes marked "Verified" need `auth.users.email_confirmed_at` populated; the global `EmailVerifiedGuard` returns 403 `EMAIL_UNVERIFIED` otherwise.

Tokens come from the Supabase Auth response — `accessToken` is the JWT you put in `Authorization`; `refreshToken` is what `/auth/refresh` consumes. Store both client-side (httpOnly cookie or secure storage); the access token expires hourly.

### Auth

#### Signup

```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "jane@example.com",
    "password": "S3cure!passphrase",
    "username": "jane_doe"
  }'
```

Creates `auth.users` + `public.users` + empty `public.profiles` via trigger and sends a verification email.

**`201 Created`**
```json
{
  "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
  "emailConfirmationRequired": true
}
```

**`409 Conflict`** — username reserved, username taken, or email already registered
```json
{ "statusCode": 409, "message": "Username already taken", "error": "Conflict" }
```

**`400 Bad Request`** — DTO validation (bad email, short password, malformed username)
```json
{
  "statusCode": 400,
  "message": ["password must be longer than or equal to 8 characters"],
  "error": "Bad Request"
}
```

#### Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "jane@example.com",
    "password": "S3cure!passphrase"
  }'
```

**`200 OK`**
```json
{
  "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
  "session": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "v1.MfYx...",
    "expiresIn": 3600,
    "tokenType": "bearer"
  }
}
```

**`401 Unauthorized`** — wrong email/password
```json
{ "statusCode": 401, "message": "Invalid credentials", "error": "Unauthorized" }
```

**`403 Forbidden`** — soft-deleted account
```json
{
  "statusCode": 403,
  "message": { "code": "ACCOUNT_DELETED", "message": "Account is pending deletion. Restore it via the email link." },
  "error": "Forbidden"
}
```

**`403 Forbidden`** — banned account
```json
{ "statusCode": 403, "message": { "code": "ACCOUNT_BANNED", "message": "Account banned" }, "error": "Forbidden" }
```

#### Logout

```bash
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

**`204 No Content`** — empty body.

**`401 Unauthorized`** — missing bearer token
```json
{ "statusCode": 401, "message": "Missing bearer token", "error": "Unauthorized" }
```

#### Refresh

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{ "refreshToken": "<refresh-jwt>" }'
```

**`200 OK`**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "v1.MfYx...",
  "expiresIn": 3600,
  "tokenType": "bearer"
}
```

**`401 Unauthorized`** — refresh token expired, revoked, or malformed
```json
{ "statusCode": 401, "message": "Invalid refresh token", "error": "Unauthorized" }
```

#### Resend verification

```bash
curl -X POST http://localhost:3000/api/v1/auth/resend-verification \
  -H 'Content-Type: application/json' \
  -d '{ "email": "jane@example.com" }'
```

Throttled to 3 / 60 s per IP. Intentionally swallows "no such user" to avoid leaking account existence.

**`204 No Content`** — empty body whether or not the email exists.

**`429 Too Many Requests`** — IP-level throttle (NestJS `ThrottlerGuard`)
```json
{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }
```

**`400 Bad Request`** — Supabase responded with its own 429 (per-email cooldown)
```json
{ "statusCode": 400, "message": "Too many verification emails requested", "error": "Bad Request" }
```

**Field constraints:**

| Field      | Rule                                                       |
| ---------- | ---------------------------------------------------------- |
| `email`    | valid email, ≤ 254 chars                                   |
| `password` | 8–128 chars                                                |
| `username` | `^[a-zA-Z0-9_-]{3,24}$`, not in reserved list, citext-unique |

### Users

#### Get own account

```bash
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN"
```

Readable even when unverified so the client can decide whether to show the verification banner.

**`200 OK`** — includes the nested `profile` relation.
```json
{
  "id": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
  "username": "jane_doe",
  "role": "user",
  "accountStatus": "active",
  "isOnline": true,
  "lastActiveAt": "2026-05-14T09:12:33.412Z",
  "onboardingCompleted": false,
  "deletedAt": null,
  "createdAt": "2026-05-10T14:02:11.001Z",
  "updatedAt": "2026-05-14T09:12:33.412Z",
  "profile": {
    "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
    "displayName": "jane_doe",
    "gender": null,
    "seeking": [],
    "dob": null,
    "country": null,
    "bio": null,
    "interests": [],
    "languages": [],
    "avatarUrl": null,
    "coverUrl": null,
    "visibility": "public",
    "completionScore": 0,
    "createdAt": "2026-05-10T14:02:11.001Z",
    "updatedAt": "2026-05-10T14:02:11.001Z"
  }
}
```

**`401 Unauthorized`** — missing/expired token (no body, NestJS default)

**`404 Not Found`** — token decodes but the `public.users` row was deleted out from under it
```json
{ "statusCode": 404, "message": "User not found", "error": "Not Found" }
```

#### Update own account (rename)

```bash
curl -X PATCH http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "username": "jane.d" }'
```

`username` is the only mutable field on `/users/me`; everything else lives on the profile.

**`200 OK`** — full user object (same shape as GET `/users/me`).

**`403 Forbidden`** — caller hasn't verified email
```json
{ "statusCode": 403, "message": { "code": "EMAIL_UNVERIFIED", "message": "Email verification required" }, "error": "Forbidden" }
```

**`409 Conflict`** — taken or reserved
```json
{ "statusCode": 409, "message": "Username already taken", "error": "Conflict" }
```

**`400 Bad Request`** — fails regex / length
```json
{
  "statusCode": 400,
  "message": ["Username must be 3–24 chars, letters/digits/underscore/hyphen"],
  "error": "Bad Request"
}
```

#### Get any user by id

```bash
curl http://localhost:3000/api/v1/users/<userId> \
  -H "Authorization: Bearer $TOKEN"
```

Returns the same row shape as `/users/me` (the entity has no email column — sensitive auth data lives in `auth.users`, never exposed). **404 if the target isn't `active`** — don't leak existence of suspended/banned/deleted accounts.

**`200 OK`** — user object with nested `profile`.

**`403 Forbidden`** — caller unverified (`EMAIL_UNVERIFIED`).

**`404 Not Found`**
```json
{ "statusCode": 404, "message": "User not found", "error": "Not Found" }
```

**`400 Bad Request`** — `id` isn't a UUID
```json
{ "statusCode": 400, "message": "Validation failed (uuid is expected)", "error": "Bad Request" }
```

#### Presence heartbeat

```bash
curl -X POST http://localhost:3000/api/v1/users/me/presence \
  -H "Authorization: Bearer $TOKEN"
```

Call every 30–60 s while the app is foregrounded. Flips `is_online=true`, stamps `last_active_at=now()`. A backend cron flips users offline after 2 min of silence.

**`204 No Content`** — empty body.

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

#### Soft delete

```bash
curl -X DELETE http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN"
```

Flips `account_status='deleted'` and `is_online=false`, mints a signed restore JWT (default TTL 60 d). In dev the URL is returned in the response body for testing; in production it's emailed and the body still includes it for client logging.

**`202 Accepted`**
```json
{ "restoreUrl": "/users/me/restore?token=eyJhbGciOiJIUzI1NiIs..." }
```

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

**`404 Not Found`** — user row already gone
```json
{ "statusCode": 404, "message": "User not found", "error": "Not Found" }
```

#### Restore from email link

```bash
curl -X POST http://localhost:3000/api/v1/users/me/restore \
  -H 'Content-Type: application/json' \
  -d '{ "token": "<restore-jwt-from-email>" }'
```

Public route (no bearer needed) so a logged-out user can recover their account.

**`200 OK`**
```json
{ "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab" }
```

**`401 Unauthorized`** — bad signature, expired token, wrong `purpose` claim, or account isn't in `deleted` state
```json
{ "statusCode": 401, "message": "Invalid or expired restore token", "error": "Unauthorized" }
```

**`404 Not Found`** — the `sub` claim points to a user that no longer exists (hard-deleted past grace period)
```json
{ "statusCode": 404, "message": "User not found", "error": "Not Found" }
```

**`400 Bad Request`** — `token` field missing or not a JWT
```json
{ "statusCode": 400, "message": ["token must be a jwt string"], "error": "Bad Request" }
```

### Profiles — own profile

#### Get own profile

```bash
curl http://localhost:3000/api/v1/profiles/me \
  -H "Authorization: Bearer $TOKEN"
```

Readable even when unverified so onboarding can prefill.

**`200 OK`** — every column on `public.profiles`. Empty values come back as `null` (scalars) or `[]` (text arrays).
```json
{
  "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
  "displayName": "Jane",
  "gender": "female",
  "seeking": ["male"],
  "dob": "1996-08-12",
  "maritalStatus": "single",
  "relationshipType": "serious",
  "country": "Ethiopia",
  "city": "Addis Ababa",
  "address": null,
  "bio": "Designer, hiker, cortado enthusiast.",
  "lookingFor": "Someone curious and kind.",
  "likes": null,
  "interests": ["hiking", "design", "coffee"],
  "favoritePlaces": [],
  "languages": ["en", "am"],
  "religion": null,
  "children": null,
  "smoking": null,
  "drinking": null,
  "heightCm": 168,
  "weightKg": null,
  "hairColor": null,
  "eyeColor": null,
  "bodyType": null,
  "ethnicity": null,
  "profession": "Product Designer",
  "avatarUrl": "https://<project>.supabase.co/storage/v1/object/public/avatars/9f4a9b2c.../avatar-1715680000000.jpg",
  "coverUrl": null,
  "visibility": "public",
  "completionScore": 85,
  "createdAt": "2026-05-10T14:02:11.001Z",
  "updatedAt": "2026-05-14T09:12:33.412Z"
}
```

**`404 Not Found`** — profile row missing (should never happen post-signup — the trigger seeds it)
```json
{ "statusCode": 404, "message": "Profile not found", "error": "Not Found" }
```

#### Update own profile

```bash
curl -X PATCH http://localhost:3000/api/v1/profiles/me \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "displayName": "Jane",
    "gender": "female",
    "seeking": ["male"],
    "dob": "1996-08-12",
    "maritalStatus": "single",
    "relationshipType": "serious",
    "country": "Ethiopia",
    "city": "Addis Ababa",
    "bio": "Designer, hiker, cortado enthusiast.",
    "lookingFor": "Someone curious and kind.",
    "interests": ["hiking", "design", "coffee"],
    "languages": ["en", "am"],
    "heightCm": 168,
    "profession": "Product Designer",
    "visibility": "public"
  }'
```

Backend recomputes `completionScore` and flips `users.onboardingCompleted=true` once all required fields are filled (`displayName`, `gender`, `seeking`, `dob`, `country`, `avatarUrl`, `bio` with ≥ 20 chars).

**`200 OK`** — full profile object (same shape as GET) with refreshed `completionScore` and `updatedAt`.

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

**`400 Bad Request`** — DTO validation. Common failures:
```json
{ "statusCode": 400, "message": ["Must be at least 18 years old"], "error": "Bad Request" }
```
```json
{
  "statusCode": 400,
  "message": [
    "gender must be one of the following values: male, female, non_binary, other, prefer_not_to_say",
    "bio must be shorter than or equal to 2000 characters"
  ],
  "error": "Bad Request"
}
```

**`400 Bad Request`** — DB `profiles_age_18_plus` constraint fired (only reachable if the DTO 18+ check is bypassed)
```json
{ "statusCode": 400, "message": "new row for relation \"profiles\" violates check constraint \"profiles_age_18_plus\"" }
```

**Mutable profile fields** (all optional on PATCH; send only what you change):

| Field                                                                                                          | Type                                                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `displayName`                                                                                                  | string, 1–80                                                               |
| `gender`                                                                                                       | `male` \| `female` \| `non_binary` \| `other` \| `prefer_not_to_say`        |
| `seeking`                                                                                                      | string[], max 10                                                           |
| `dob`                                                                                                          | `YYYY-MM-DD`, must be 18+                                                  |
| `maritalStatus`                                                                                                | `single` \| `married` \| `divorced` \| `widowed` \| `separated` \| `other` |
| `relationshipType`                                                                                             | `serious` \| `casual` \| `friendship` \| `affair` \| `marriage` \| `open`  |
| `country` / `city` / `address`                                                                                 | string, ≤ 80 / 120 / 240                                                   |
| `bio` / `lookingFor` / `likes`                                                                                 | string, ≤ 2000 each                                                        |
| `interests` / `favoritePlaces`                                                                                 | string[], max 30                                                           |
| `languages`                                                                                                    | string[], max 20                                                           |
| `religion`                                                                                                     | string, ≤ 80                                                               |
| `children`                                                                                                     | `none` \| `have` \| `want` \| `dont_want` \| `maybe`                       |
| `smoking`                                                                                                      | `never` \| `casual` \| `regular` \| `trying_to_quit`                       |
| `drinking`                                                                                                     | `never` \| `socially` \| `regularly`                                       |
| `heightCm`                                                                                                     | int, 80–260                                                                |
| `weightKg`                                                                                                     | int, 30–400                                                                |
| `hairColor` / `eyeColor` / `bodyType`                                                                          | string, ≤ 40                                                               |
| `ethnicity`                                                                                                    | string, ≤ 80                                                               |
| `profession`                                                                                                   | string, ≤ 120                                                              |
| `avatarUrl` / `coverUrl`                                                                                       | string, ≤ 2048 (usually set via the upload flow below, not by hand)        |
| `visibility`                                                                                                   | `public` \| `members_only` \| `private`                                    |

### Profiles — viewing others

```bash
curl http://localhost:3000/api/v1/profiles/<userId> \
  -H "Authorization: Bearer $TOKEN"
```

Visibility semantics:
- `public` / `members_only` → visible to any verified caller (and to the owner regardless of status).
- `private` → 404 to everyone except the owner.
- Target user must be `active`, else 404. The 404 is intentional: don't leak whether the user exists.

**`200 OK`** — same shape as `/profiles/me`.

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

**`404 Not Found`** — private, suspended/banned/deleted target, or genuinely no such user
```json
{ "statusCode": 404, "message": "Profile not found", "error": "Not Found" }
```

**`400 Bad Request`** — `userId` isn't a UUID.

### Profiles — avatar / cover upload

Two-step flow: ask the backend for a signed upload URL, then PUT the file bytes to Supabase Storage. Step 3 patches the URL onto the profile.

#### Step 1 — request signed upload

```bash
# Avatar
curl -X POST http://localhost:3000/api/v1/profiles/me/avatar-upload \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "mimeType": "image/jpeg", "size": 204800 }'

# Cover (identical body)
curl -X POST http://localhost:3000/api/v1/profiles/me/cover-upload \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "mimeType": "image/png", "size": 512000 }'
```

`mimeType` ∈ `image/jpeg` | `image/png` | `image/webp`; `size` ≤ 8 MB (8388608 bytes).

**`201 Created`**
```json
{
  "bucket": "avatars",
  "path": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab/avatar-1715680000000.jpeg",
  "token": "eyJ0eXAi...short-lived-upload-token",
  "publicUrl": "https://<project>.supabase.co/storage/v1/object/public/avatars/9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab/avatar-1715680000000.jpeg"
}
```

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

**`400 Bad Request`** — bad mime type or oversize
```json
{
  "statusCode": 400,
  "message": [
    "mimeType must be one of the following values: image/jpeg, image/png, image/webp",
    "size must not be greater than 8388608"
  ],
  "error": "Bad Request"
}
```

**`500 Internal Server Error`** — Supabase Storage rejected the signing request (bucket missing, service-role key invalid)
```json
{ "statusCode": 500, "message": "Failed to create signed upload URL: Bucket not found" }
```

#### Step 2 — PUT the bytes

Not a backend route. Either use supabase-js:
```ts
await supabase.storage.from('avatars').uploadToSignedUrl(path, token, file);
```
or raw HTTP:
```bash
curl -X PUT "<SUPABASE_URL>/storage/v1/object/upload/sign/avatars/<path>?token=<token>" \
  -H 'Content-Type: image/jpeg' \
  --data-binary @./avatar.jpg
```
Supabase responds 200 with `{ "Key": "<path>" }` on success, 400/401 on bad/expired token.

#### Step 3 — persist the URL on the profile

```bash
curl -X PATCH http://localhost:3000/api/v1/profiles/me \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "avatarUrl": "<publicUrl-from-step-1>" }'
```

Same response shape as the main PATCH above.

### Profiles — search (members directory)

```bash
curl -G http://localhost:3000/api/v1/profiles/search \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'gender=female' \
  --data-urlencode 'seeking=male' \
  --data-urlencode 'interests=hiking,design' \
  --data-urlencode 'country=Ethiopia' \
  --data-urlencode 'profession=Designer' \
  --data-urlencode 'minAge=24' \
  --data-urlencode 'maxAge=35' \
  --data-urlencode 'q=jane' \
  --data-urlencode 'sort=most_active' \
  --data-urlencode 'page=1' --data-urlencode 'limit=20'
```

All filters optional. `interests` and `seeking` accept CSV (`?interests=hiking,design`) or repeated query params. `q` triggers trigram match on `display_name`. Sort: `newest` | `most_active` | `popular` (default `newest`). Results are scoped to `active` users with `visibility IN ('public','members_only')`.

**`200 OK`** — `items` is an array of profile rows (each also has its nested `user` mini-row). `total` is the unfiltered count for the same query.
```json
{
  "items": [
    {
      "userId": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
      "displayName": "Jane",
      "gender": "female",
      "seeking": ["male"],
      "dob": "1996-08-12",
      "country": "Ethiopia",
      "city": "Addis Ababa",
      "bio": "Designer, hiker, cortado enthusiast.",
      "interests": ["hiking", "design", "coffee"],
      "languages": ["en", "am"],
      "profession": "Product Designer",
      "avatarUrl": "https://<project>.supabase.co/storage/v1/object/public/avatars/.../avatar-1715680000000.jpg",
      "visibility": "public",
      "completionScore": 85,
      "createdAt": "2026-05-10T14:02:11.001Z",
      "updatedAt": "2026-05-14T09:12:33.412Z",
      "user": {
        "id": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
        "username": "jane_doe",
        "role": "user",
        "accountStatus": "active",
        "isOnline": true,
        "lastActiveAt": "2026-05-14T09:12:33.412Z",
        "onboardingCompleted": true,
        "createdAt": "2026-05-10T14:02:11.001Z",
        "updatedAt": "2026-05-14T09:12:33.412Z"
      }
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

Empty result:
```json
{ "items": [], "total": 0, "page": 1, "limit": 20 }
```

**`403 Forbidden`** — `EMAIL_UNVERIFIED`.

**`400 Bad Request`** — query param outside its bounds
```json
{
  "statusCode": 400,
  "message": [
    "minAge must not be less than 18",
    "limit must not be greater than 100",
    "sort must be one of the following values: newest, most_active, popular"
  ],
  "error": "Bad Request"
}
```

**Query params:**

| Param        | Type                                       | Notes                                       |
| ------------ | ------------------------------------------ | ------------------------------------------- |
| `gender`     | string                                     | exact match                                 |
| `seeking`    | string[] (CSV or repeated)                 | GIN overlap (`&&`)                          |
| `interests`  | string[] (CSV or repeated)                 | GIN overlap (`&&`)                          |
| `country`    | string                                     | exact match                                 |
| `profession` | string                                     | exact match                                 |
| `minAge`     | int, 18–120                                | derived to `dob <= today - minAge years`    |
| `maxAge`     | int, 18–120                                | derived to `dob >= today - maxAge years`    |
| `q`          | string, ≤ 80                               | trigram match on `display_name`             |
| `sort`       | `newest` \| `most_active` \| `popular`     | default `newest`                            |
| `page`       | int, ≥ 1                                   | default `1`                                 |
| `limit`      | int, 1–100                                 | default `20`                                |

### Admin (`role='admin'` on `public.users`)

All admin writes are recorded to `public.audit_log` with `{ actorId, targetId, action, metadata }`. Non-admin callers get `403 Forbidden` from `RolesGuard` on every route below.

#### List users

```bash
curl -G http://localhost:3000/api/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-urlencode 'status=active' \
  --data-urlencode 'role=user' \
  --data-urlencode 'onboardingCompleted=true' \
  --data-urlencode 'createdAfter=2026-01-01' \
  --data-urlencode 'createdBefore=2026-12-31' \
  --data-urlencode 'page=1' --data-urlencode 'limit=50'
```

**`200 OK`**
```json
{
  "items": [
    {
      "id": "9f4a9b2c-1e7c-4d1f-8a2a-3c8f7b0d12ab",
      "username": "jane_doe",
      "role": "user",
      "accountStatus": "active",
      "isOnline": true,
      "lastActiveAt": "2026-05-14T09:12:33.412Z",
      "onboardingCompleted": true,
      "deletedAt": null,
      "createdAt": "2026-05-10T14:02:11.001Z",
      "updatedAt": "2026-05-14T09:12:33.412Z"
    }
  ],
  "total": 1247,
  "page": 1,
  "limit": 50
}
```

**`403 Forbidden`** — caller isn't an admin.
```json
{ "statusCode": 403, "message": "Forbidden resource", "error": "Forbidden" }
```

**`400 Bad Request`** — bad enum / date format
```json
{
  "statusCode": 400,
  "message": [
    "status must be one of the following values: active, suspended, banned, deleted",
    "createdAfter must be a valid ISO 8601 date string"
  ],
  "error": "Bad Request"
}
```

#### Suspend / unsuspend / ban

```bash
curl -X POST http://localhost:3000/api/v1/admin/users/<userId>/suspend  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST http://localhost:3000/api/v1/admin/users/<userId>/unsuspend -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST http://localhost:3000/api/v1/admin/users/<userId>/ban       -H "Authorization: Bearer $ADMIN_TOKEN"
```

`suspend` → `account_status='suspended'`. `unsuspend` → `'active'`. `ban` → `'banned'` (the JWT strategy refuses every subsequent request from a banned user). Each writes an audit row with `{ from, to }`.

**`204 No Content`** — empty body.

**`404 Not Found`** — target user doesn't exist
```json
{ "statusCode": 404, "message": "User not found", "error": "Not Found" }
```

**`403 Forbidden`** — non-admin caller.

**`400 Bad Request`** — `userId` isn't a UUID.

#### Set role

```bash
curl -X POST http://localhost:3000/api/v1/admin/users/<userId>/role \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "role": "moderator" }'
```

`role` ∈ `user` | `moderator` | `admin`. Audit-logged with `from`/`to`.

**`204 No Content`** — empty body.

**`404 Not Found`** — target user doesn't exist.

**`400 Bad Request`** — bad enum
```json
{
  "statusCode": 400,
  "message": ["role must be one of the following values: user, moderator, admin"],
  "error": "Bad Request"
}
```

**`403 Forbidden`** — non-admin caller.

#### Flagged profiles (placeholder)

```bash
curl http://localhost:3000/api/v1/admin/profiles/flagged \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Stays empty until the Reports model lands.

**`200 OK`**
```json
{ "items": [], "total": 0 }
```

**`403 Forbidden`** — non-admin caller.

### Error codes the frontend should special-case

| HTTP | Code                | When                                                                 |
| ---- | ------------------- | -------------------------------------------------------------------- |
| 401  | _(any)_             | Missing/expired access token — try `/auth/refresh`, else re-login.   |
| 403  | `EMAIL_UNVERIFIED`  | Verified-only route hit by an unverified user. Show resend banner.   |
| 403  | `ACCOUNT_BANNED`    | Banned account tried to use any route. Force logout.                 |
| 401  | `ACCOUNT_DELETED`   | `/auth/login` on a soft-deleted account. Show "restore via email".   |
| 404  | _(any)_             | Profile is private / user not active / blocked viewer — treat as "not found", don't leak existence. |
| 429  | _(any)_             | Throttled (signup, resend-verification). Show "try again in a minute". |

### Route reference at a glance

| Method | Path                                | Auth         | Gate                              |
| ------ | ----------------------------------- | ------------ | --------------------------------- |
| POST   | `/auth/signup`                      | —            | `@Public()`                       |
| POST   | `/auth/login`                       | —            | `@Public()`                       |
| POST   | `/auth/logout`                      | Bearer       | —                                 |
| POST   | `/auth/refresh`                     | —            | `@Public()`                       |
| POST   | `/auth/resend-verification`         | —            | `@Public()`, throttled            |
| GET    | `/users/me`                         | Bearer       | —                                 |
| PATCH  | `/users/me`                         | Bearer       | Verified                          |
| GET    | `/users/:id`                        | Bearer       | Verified                          |
| POST   | `/users/me/presence`                | Bearer       | Verified                          |
| DELETE | `/users/me`                         | Bearer       | Verified                          |
| POST   | `/users/me/restore`                 | —            | `@Public()` (signed token)        |
| GET    | `/profiles/me`                      | Bearer       | —                                 |
| PATCH  | `/profiles/me`                      | Bearer       | Verified                          |
| GET    | `/profiles/:userId`                 | Bearer       | Verified + visibility/status      |
| POST   | `/profiles/me/avatar-upload`        | Bearer       | Verified                          |
| POST   | `/profiles/me/cover-upload`         | Bearer       | Verified                          |
| GET    | `/profiles/search`                  | Bearer       | Verified                          |
| GET    | `/admin/users`                      | Bearer       | `role='admin'`                    |
| POST   | `/admin/users/:id/suspend`          | Bearer       | `role='admin'`                    |
| POST   | `/admin/users/:id/unsuspend`        | Bearer       | `role='admin'`                    |
| POST   | `/admin/users/:id/ban`              | Bearer       | `role='admin'`                    |
| POST   | `/admin/users/:id/role`             | Bearer       | `role='admin'`                    |
| GET    | `/admin/profiles/flagged`           | Bearer       | `role='admin'`                    |

> Storage prerequisite: create the `avatars` and `covers` buckets in Supabase Studio before exercising the upload endpoints.
