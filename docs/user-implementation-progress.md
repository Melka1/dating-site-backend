# User + Profile — implementation progress

Tracks the build-out of the plan in [docs/user.md](./user.md). Each phase lists what is already in the repo and what still needs to be wired up. Pick up by working through the **Remaining** list top-down.

---

## Phase 1 — Supabase foundation

**Done**

- Migration `src/database/migrations/1714000000000-UserProfileSchema.ts` provisions:
  - `citext` + `pg_trgm` extensions
  - `public.users` + `public.profiles` with all check constraints and indexes from `docs/user.md`
  - `handle_new_user`, `touch_updated_at`, `sync_deleted_at` triggers
  - RLS policies on both tables
  - `public.audit_log` table + indexes for Phase 7

**Remaining**

- ~~Run `npm run migration:run` against the Supabase Postgres instance.~~ Applied against the local Supabase Postgres on 2026-05-11.
- Manual in Supabase console: enable email auth, set verification + restore email templates, create Storage buckets `avatars` and `covers` (public read or signed URLs as per policy).
- Populate `.env` with the Supabase project values (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, database pooler creds, `RESTORE_TOKEN_SECRET`). Local-dev values are populated against `127.0.0.1:54322`; production creds still needed.

## Phase 2 — NestJS scaffold

**Done**

- `SupabaseModule` (global) — `SupabaseAdminService` (service role) + request-scoped `SupabaseUserService` (forwards caller JWT so RLS sees `auth.uid()`).
- `JwtStrategy` now verifies **Supabase-signed** access tokens with `SUPABASE_JWT_SECRET` (HS256) and enriches the payload from `public.users` (role + status gate). Banned/deleted accounts are refused at the guard boundary.
- `EmailVerifiedGuard` + `@RequireVerified()` decorator (`src/modules/auth/guards/email-verified.guard.ts`, `decorators/require-verified.decorator.ts`). Returns 403 `EMAIL_UNVERIFIED`.
- `AuditModule` (global) exposes `AuditService.record({ actorId, targetId, action, metadata })`.
- `env.validation.ts` + `configuration.ts` updated: Supabase keys now required; added `PRESENCE_OFFLINE_THRESHOLD_SECONDS`, `SOFT_DELETE_GRACE_DAYS`, restore-token config.

**Remaining**

- ~~Register guards globally in `src/app.module.ts`~~ — done; all four `APP_GUARD`s (`ThrottlerGuard`, `JwtAuthGuard`, `EmailVerifiedGuard`, `RolesGuard`) are wired in [src/app.module.ts](../src/app.module.ts). `@Public()` is applied to signup/login/refresh/resend-verification/restore.
- ~~Add `ScheduleModule.forRoot()` import to `AppModule`~~ — done.

## Phase 3 — Auth module

**Done**

- `POST /auth/signup` — validates username (regex, reserved list, DB uniqueness), calls `supabase.auth.admin.createUser` with `user_metadata.username`; `handle_new_user` trigger provisions the `public.users` + `public.profiles` rows.
- `POST /auth/login` — `signInWithPassword`, then refuses `deleted` / `banned` accounts with `ACCOUNT_DELETED` / `ACCOUNT_BANNED` codes (session revoked if refused).
- `POST /auth/logout` — revokes the caller's Supabase session.
- `POST /auth/refresh` — `supabase.auth.refreshSession`.
- `POST /auth/resend-verification` — throttled (3 / 60s), swallows non-429 errors to avoid leaking account existence.

**Remaining (optional polish)**

- Add a profanity filter for usernames if moderation needs it.
- Surface `ACCOUNT_DELETED` on the login UI with a "check your email for the restore link" hint.

## Phase 4 — Users module

**Done** — [src/modules/users/](../src/modules/users/).

- `UsersService` implements `findMe`, `patchMe` (username-only, reserved-list + uniqueness), `findPublic` (404 unless `active`), `heartbeat` (raw `now()` SQL), `softDelete` (flips status, issues restore JWT, audit-logs — sends the URL via Logger pending a real email provider), `restore` (verifies JWT, flips back to active).
- `UsersController` exposes `GET/PATCH /users/me`, `POST /users/me/presence`, `DELETE /users/me`, `POST /users/me/restore` (`@Public()`), `GET /users/:id`.
- `UsersModule` registers `JwtModule.register({})` so the restore-token signer is DI-available; re-exports `TypeOrmModule.forFeature([User])`.

**Open**

- Supabase admin cannot revoke a session by `userId` in supabase-js v2 — `signOut` takes a JWT. We rely on `JwtStrategy` rejecting deleted/banned accounts at the guard boundary instead. Revisit if Supabase ships a userId-based revoke.
- Restore-email delivery is a `Logger.log` for now; wire to a transactional email provider before launch.

## Phase 5 — Profiles module

**Done** — [src/modules/profiles/](../src/modules/profiles/).

- `ProfilesService` implements `findMe`, `findPublic` (visibility + account_status), `patchMe` (with completion recompute + `onboarding_completed` flip), `requestAvatarUpload` / `requestCoverUpload` (returns Supabase Storage signed upload tokens + public URL), `search` (parameterised gender/seeking/interests/country/profession/age-range/trigram with newest/most_active/popular sort + pagination).
- `ProfilesController` exposes `GET/PATCH /profiles/me`, `POST /profiles/me/{avatar,cover}-upload`, `GET /profiles/search`, `GET /profiles/:userId`. All require verified email except `GET /profiles/me`.
- DTOs: [update-profile.dto.ts](../src/modules/profiles/dto/update-profile.dto.ts) (every mutable field, age-18 validator), [search-profiles.dto.ts](../src/modules/profiles/dto/search-profiles.dto.ts), [signed-upload.dto.ts](../src/modules/profiles/dto/signed-upload.dto.ts) (mime + size).
- `ProfilesModule` registers `TypeOrmModule.forFeature([Profile, User])`.

**Open**

- Block model — `findPublic` cannot filter blocked viewers yet.
- `recomputeCompletion` runs synchronously inside `patchMe`; consider a background recompute if profile reads outgrow writes.

## Phase 6 — Deletion + restoration

**Done**

- Soft-delete + restore live in Users module (Phase 4).
- Retention cron at [src/modules/retention/retention.cron.ts](../src/modules/retention/retention.cron.ts) runs daily at 03:00 UTC, scans `users` where `account_status='deleted' AND deleted_at < now() - grace_days`, hard-deletes via `auth.admin.deleteUser` (FK cascade clears `public.*`), audit-logs each.

## Phase 7 — Admin module

**Done** — [src/modules/admin/](../src/modules/admin/). Guards are wired globally so the controllers only need `@Roles(UserRole.ADMIN)`.

- `AdminUsersController`:
  - `GET /admin/users` — paginated list with filters (status, role, onboardingCompleted, createdAfter/createdBefore).
  - `POST /admin/users/:id/{suspend,unsuspend,ban,role}` — mutate `account_status` / `role`, audit-log each with `from`/`to`.
- `AdminProfilesController.GET /admin/profiles/flagged` — empty-list placeholder until a Reports model lands.

## Phase 8 — Frontend wiring

Out of scope for the backend repo — track under the frontend plan.

## Phase 9 — Tests

- e2e (`test/`): signup → (fake-confirm) → login → patch profile → search; verified-only endpoints return 403 when unverified; deleted account refuses login; restore round-trip.
- DB: pgTAP or a Supabase SQL harness for RLS, `handle_new_user`, `sync_deleted_at`, 18+ constraint, `users_deleted_at_consistency`.
- Unit: `AuthService`, `UsersService`, `ProfilesService` with the Supabase client mocked.

---

## What the build looks like right now

- `npx tsc --noEmit -p tsconfig.build.json` → clean.
- `npm run start` boots cleanly with all routes mapped — auth, users, profiles, admin, retention, health.
- Phases 1–7 are landed. Remaining backend work is Phase 9 (tests) plus the open items below.

## Open items carried over from docs/user.md

- Restore-token format: currently proposed as a backend-signed JWT (`RESTORE_TOKEN_SECRET`, `RESTORE_TOKEN_EXPIRES_IN`). Revisit if we'd rather use Supabase magic-link with a `restore` claim.
- Deletion side-effects on downstream content (posts, messages) — resolve per-model.
- `members_only` vs `public` visibility behaves identically until anonymous browsing is introduced.
- Friends-only visibility waits on the Friendship model.
- Grace-period reminder emails (T-7d / T-1d).
- Required onboarding fields — tune after real sign-ups.
- Profession free-text vs curated list.
