# Guest access & tiered visibility — proposal

**Status:** proposal, not yet implemented. Review and redirect before any code lands.

Today every request that doesn't carry `@Public()` requires a verified JWT. This locks unauthenticated visitors out of read paths that should be open: browsing public profiles, searching members, reading public group descriptions, opening a public post link. The frontend has no way to render a "logged-out browse" experience.

This doc proposes a small, repeatable pattern — **optional auth + a viewer-tier-based DTO projection** — that lets guests read public information while members continue to see the richer view, with consistent rules across every module.

---

## Goals

1. Guests (no bearer token) can `GET` an explicit allowlist of read endpoints: user search, group search, public profiles, public posts, top-level comments on public posts.
2. The response a guest receives is a **subset** of the response a member receives. Same endpoint, smaller DTO. No second URL.
3. Members continue to see the richer view; friends/self continue to see the richest.
4. All writes, all "me" endpoints, and anything touching friends/private/group audiences remain authenticated.
5. Guest reads carry a stricter rate limit than authenticated reads.
6. The mechanism is **uniform** — when we add Phase 2 features (Notifications, Conversations), the same `Viewer` plumbing reuses.

---

## Non-goals

- We are **not** building anonymous user accounts or "session-less identities". A guest is just "no `req.user`".
- We are **not** removing `@RequireVerified()` from any write route.
- We are **not** loosening visibility on `friends` / `private` / `group` posts — those remain hidden from guests, full stop.
- We are **not** introducing GraphQL or per-field permissions. Projection happens in the service layer at DTO assembly time.

---

## Today's auth chain (recap)

[src/app.module.ts](../src/app.module.ts) registers four global guards, in this order:

1. `ThrottlerGuard` — IP-bucket rate limit.
2. `JwtAuthGuard` — extracts the bearer token, calls `JwtStrategy.validate`, populates `req.user`. `@Public()` opts out of token *validation* but the strategy is never invoked, so `req.user` is `undefined`.
3. `EmailVerifiedGuard` — enforces `@RequireVerified()` against `req.user.emailConfirmedAt`.
4. `RolesGuard` — enforces `@Roles()` against `req.user.role`.

`@CurrentUser('sub')` reads from `req.user`. Today this is binary: token-present-and-valid, or 401.

---

## Proposal at a glance

| Piece | Today | Proposed |
|---|---|---|
| Auth on read routes | Required (or `@Public()` skips entirely) | New `@OptionalAuth()` — token *parsed if present*, route still callable without one |
| `req.user` on a guest | `undefined` (only on `@Public()` routes) | `undefined` on `@OptionalAuth()` routes too — but the route runs |
| DTO shape | One shape regardless of viewer | One shape, with redacted fields nulled / omitted based on viewer tier |
| Visibility decisions | App-layer + RLS | Same — the `Viewer` object is the input to both |
| Rate limit | Single global bucket | Two buckets — `guest` (stricter, IP-keyed), `auth` (current limits, user-keyed) |

---

## Mechanism 1 — `@OptionalAuth()` decorator

A new decorator + a small change to `JwtAuthGuard`:

- `@OptionalAuth()` marks the route. Inside `JwtAuthGuard.canActivate`, if the route is optional-auth:
  - If no `Authorization` header → `req.user = undefined`, return `true`.
  - If a header is present → run the strategy as usual. **Bad tokens still 401** — we don't silently degrade to guest when a member presents stale credentials, because the frontend needs to know to refresh.
- `EmailVerifiedGuard` and `RolesGuard` no-op when `req.user` is undefined (they already skip routes that don't carry `@RequireVerified()` / `@Roles()`).
- `@Public()` stays as-is for routes that genuinely don't care about identity (health, restore-from-token-link, etc.).

The difference between `@Public()` and `@OptionalAuth()`:
- `@Public()` — "skip auth entirely, route doesn't need identity."
- `@OptionalAuth()` — "auth is optional; if a token is present, parse it; the handler will tier its response by whether `req.user` exists."

This keeps the three classes of routes legible at the call site: locked (default), optional, public.

---

## Mechanism 2 — `Viewer` + `@CurrentViewer()`

A `Viewer` value object is built per request by a custom param decorator. **The existing `@CurrentUser('sub') userId: string` pattern stays in place for routes guarded by the default JwtAuthGuard** — those routes are guaranteed a user, so they don't need the optional/null shape. Only routes that adopt `@OptionalAuth()` switch to `@CurrentViewer()`, because their `userId` may be `null`.

Two decorators, two jobs:
- `@CurrentUser('sub') userId: string` — required-auth routes (today's default). `userId` is always present.
- `@CurrentViewer() viewer: Viewer` — optional-auth routes. `viewer.userId` is `null` for guests, populated for members.

```ts
// src/common/viewer.ts
export interface Viewer {
  userId: string | null;
  emailConfirmedAt: Date | null;
  role: UserRole | null;
  isAuthenticated: boolean;  // userId !== null
  isStaff: boolean;          // role in (moderator, admin)
  isAdmin: boolean;
}

export const GUEST_VIEWER: Viewer = { ... };
export function viewerFromJwt(payload: JwtPayload | undefined): Viewer { ... }
```

The *coarse* tier (`guest` / `member` / `staff`) is known at request entry from the Viewer. The *resource-relative* tier (`self` / `friend`) is computed inside services that already need to know — e.g. `PostsService.assertVisible` already checks "are these two users friends". We thread that result into the projection, not into the Viewer itself, because friend-ness is per-target.

```ts
// inside a service, when building a DTO for a specific target user:
const tier = resolveProfileTier(viewer, targetUserId, {
  friendsWith: await this.friends.areFriends(viewer.userId, targetUserId),
});
return projectProfile(profile, tier);
```

---

## Mechanism 3 — per-resource projection

Each module owns a `projectXForTier(entity, tier)` function. **No global "redaction middleware"** — the rules differ per resource and are easier to reason about co-located with the DTO definition.

The projection contract: every projection function returns the **same TypeScript type**, but with fields set to `null` (or arrays emptied) when the tier doesn't earn them. The frontend renders accordingly.

Rationale: a single union type "PublicPost | MemberPost | SelfPost" leaks tier into every consumer; nullable fields keep the consumer code uniform.

---

## Per-resource field matrix

Tables read as: **column = viewer tier, cell = is this field included**. ✅ shown, ⚪ shown but redacted/coarsened, ❌ omitted (null / absent).

### Profile

| Field | Guest | Member | Friend | Self |
|---|---|---|---|---|
| `userId`, `username`, `displayName`, `avatarUrl` | ✅ | ✅ | ✅ | ✅ |
| `gender`, `seeking`, `relationshipType` | ✅ | ✅ | ✅ | ✅ |
| `country` | ✅ | ✅ | ✅ | ✅ |
| `city` | ❌ | ✅ | ✅ | ✅ |
| `bio`, `lookingFor`, `likes` | ⚪ first 200 chars | ✅ | ✅ | ✅ |
| `interests`, `languages`, `religion` | ✅ | ✅ | ✅ | ✅ |
| `dob` / age | ❌ | ⚪ "30s" bucket | ✅ exact | ✅ exact |
| `heightCm`, `weightKg`, `bodyType`, `ethnicity` | ❌ | ✅ | ✅ | ✅ |
| `profession`, `coverUrl` | ✅ | ✅ | ✅ | ✅ |
| `lastActiveAt`, `isOnline` | ❌ | ⚪ "active today/this week" bucket | ✅ exact | ✅ exact |
| `address` | ❌ | ❌ | ❌ | ✅ |
| `email` | ❌ | ❌ | ❌ | ✅ |

`visibility='private'` profiles → return 404 to guest and member, full DTO to self/staff.

### Post

| Field | Guest | Member | Friend (of author) | Self (author) |
|---|---|---|---|---|
| Post visible at all? | Only `audience='public'` and author not blocked-by-anyone-related | + `audience='friends'` only when friend | + `audience='friends'` | All including own private/deleted |
| `body`, `attachments`, `mentions` | ✅ | ✅ | ✅ | ✅ |
| `reactionSummary.total`, `byType` | ✅ | ✅ | ✅ | ✅ |
| `reactionSummary.topActors` | ❌ | ✅ | ✅ | ✅ |
| `reactionSummary.viewerReaction` | always `null` | ✅ | ✅ | ✅ |
| `viewerFavorited` | always `false` | ✅ | ✅ | ✅ |
| `commentCount` | ✅ | ✅ | ✅ | ✅ |

Activity feed lens enforcement for guests:
- `personal` — allowed, but only public posts come back.
- `mentions` / `favorites` / `friends` / `groups` — **400 to guests** (these lenses are intrinsically member-relative).

### Group

| Field | Guest | Member | Member of group | Owner/admin |
|---|---|---|---|---|
| `id`, `slug`, `name`, `description`, `avatarUrl`, `coverUrl` | ✅ public groups only | ✅ public + unlisted | ✅ all | ✅ all |
| `memberCount` | ⚪ rounded ("100+", "50+", "10+", "<10") | ✅ exact | ✅ exact | ✅ exact |
| `interests`, `country`, `city` | ✅ | ✅ | ✅ | ✅ |
| `rules` | ❌ | ❌ | ✅ | ✅ |
| `joinPolicy` | ✅ | ✅ | ✅ | ✅ |
| `members[]` (roster) | ❌ | ❌ for private; active-only for public/unlisted | ✅ full | ✅ full |
| `visibility='private'` group exists? | 404 | 404 | ✅ | ✅ |

### User search / member directory

| Endpoint | Guest | Member |
|---|---|---|
| `GET /users/search` | ✅ — returns profile-projection-for-guest, only `account_status='active'` and `profiles.visibility='public'` | ✅ — adds `members_only` visibility into results |
| `GET /users/:id` | ✅ — guest projection | ✅ — member projection |
| `GET /users/me` | ❌ 401 | ✅ self projection |

### Comments

Reads on a public post's comments → allowed for guests. Comment author projection follows the profile rules above. Writes remain `@RequireVerified()`.

---

## Routes touched

### Newly guest-readable (add `@OptionalAuth()`)

| Method | Path | Notes |
|---|---|---|
| GET | `/users/search`, `/users/:id` | Filtered + projected |
| GET | `/users/:userId/activity` | Only `lens=personal&sort=recent`; reject other lenses for guests |
| GET | `/posts/:id` | Only when audience='public' |
| GET | `/posts/:id/comments` | Only on guest-visible posts |
| GET | `/comments/:id/replies` | Only on guest-visible posts |
| GET | `/groups`, `/groups/search`, `/groups/:slug` | Filtered to public; projected |
| GET | `/groups/:id/members` | Active roster only on public groups; 404 elsewhere |

### Stays locked (no change)

- All `POST` / `PUT` / `PATCH` / `DELETE` routes.
- `/users/me/*`, `/users/me/favorites`.
- `/friends/*`, `/blocks/*` (intrinsically member-only).
- Activity lenses `mentions`, `favorites`, `friends`, `groups`.
- Admin namespace.

---

## The two-layer contract

There are two enforcement layers and they have distinct, non-overlapping jobs. Confusing them is the most common way authorization systems rot.

| Layer | Job | Granularity | Source of truth for… |
|---|---|---|---|
| **Service-layer projection** | "Given this viewer, what shape do we return?" — DTO redaction, lens validation, 404-vs-200 on visibility miss. | Per-field, per-tier | What every client actually sees |
| **RLS** | "Given this database role, what raw rows is it ever allowed to read or mutate?" — a deny-by-default floor for any path that bypasses Nest. | Per-row | The worst case if Nest is bypassed |

**RLS is the floor, not the ceiling.** It doesn't need to know that guests see the first 200 chars of a bio while members see the whole thing — that's projection's job. It just needs to say "the anon role can SELECT this row" or "can't". So RLS stays coarse, the service stays fine-grained, and the two never have to agree on UX details.

**Consequences:**

- Every visibility decision a client experiences is enforced in the service layer. No "RLS will catch it" excuses.
- RLS is updated only when a row that *currently* leaks under a hypothetical direct-DB client would leak something we wouldn't tolerate. Today that's exactly two items — see ["RLS follow-ups"](#rls-follow-ups) below.
- We do not add `auth.uid() IS NULL` branches across the policy set just so the anon role can read everything Nest serves to guests. The anon role doesn't talk to our DB today. When it does, we revisit.
- The Nest backend continues to connect as the `postgres` role (which bypasses RLS). The DB connection role and the application's authorization model are independent concerns.

### RLS follow-ups

These are small, independent of the rest of the guest-access plan, and worth shipping on their own:

1. **Tighten `profiles_select`.** Today the `members_only` branch fires when `auth.uid() IS NULL`, so an anon-role direct client would read members-only profiles. Require `auth.uid() IS NOT NULL` on that branch.
2. **Enable RLS on `public.audit_log` with no policies.** Deny-all to non-superusers. Costs nothing; closes the gap if the connection role is ever downgraded.

(A third item — letting guests read active rosters on public groups via `group_members_select` — is **not** on this list. Under the two-layer contract, no client talks to that table directly without going through Nest, so loosening the policy buys nothing today.)

---

## Rate limiting

Two named throttlers in [src/app.module.ts](../src/app.module.ts); exactly one applies per request, selected by `skipIf` reading `req.user`:

| Bucket | When it applies | Keyed by | Defaults | Envs |
|---|---|---|---|---|
| `default` | `req.user` is present (authenticated) | `user:<sub>` | 100 req / 60 s | `THROTTLE_TTL`, `THROTTLE_LIMIT` |
| `guest` | `req.user` is missing (unauthenticated) | `ip:<remote>` | 30 req / 60 s | `THROTTLE_GUEST_TTL`, `THROTTLE_GUEST_LIMIT` |

Headers per RFC: `X-RateLimit-Limit-default`, `X-RateLimit-Remaining-default`, `X-RateLimit-Reset-default` (and `-guest` for the other bucket).

### Why JwtAuthGuard runs before ThrottlerGuard

The original APP_GUARD order ran throttle first, then auth. That's the conventional ordering (rate-limit before doing expensive work) and we deliberately swapped it. Justification:

- The throttler needs to know **who** is calling to pick the right bucket and key. Without `req.user`, both buckets would key by IP and the per-user fairness we want disappears.
- `JwtAuthGuard.canActivate` is cheap on the cold path: missing-token returns immediately; bad-token throws fast; valid-token verifies a signature against a JWKS that is cached in-process.
- The expensive part of auth (the DB query in `JwtStrategy.validate`) runs only for valid signatures — flooding with random tokens won't reach it.

If we ever see JWKS verification under attack, an upstream IP-based pre-throttler (e.g. at the load balancer) is the right fix — not re-ordering these two guards.

Concrete numbers above are starting defaults; tune after instrumentation.

---

## Implementation phases

1. **Plumbing.** ✅ **Landed.** `@OptionalAuth()` at [src/modules/auth/decorators/optional-auth.decorator.ts](../src/modules/auth/decorators/optional-auth.decorator.ts); `JwtAuthGuard` honors it at [src/modules/auth/guards/jwt-auth.guard.ts](../src/modules/auth/guards/jwt-auth.guard.ts); `Viewer` type + `viewerFromJwt`/`GUEST_VIEWER` at [src/common/viewer.ts](../src/common/viewer.ts); `@CurrentViewer()` at [src/common/decorators/current-viewer.decorator.ts](../src/common/decorators/current-viewer.decorator.ts). No existing controllers touched — they keep `@CurrentUser('sub')`. Only routes that adopt `@OptionalAuth()` in later phases switch to `@CurrentViewer()`. Zero behavior change.
2. **Throttler split.** ✅ **Landed.** Two named throttlers in [src/app.module.ts](../src/app.module.ts): `default` (user-keyed, 100/60s) and `guest` (IP-keyed, 30/60s). Selection via `skipIf(req.user)`. APP_GUARD order swapped so JwtAuthGuard populates `req.user` before ThrottlerGuard reads it. New envs `THROTTLE_GUEST_TTL` / `THROTTLE_GUEST_LIMIT` in [env.validation.ts](../src/config/env.validation.ts) + [configuration.ts](../src/config/configuration.ts).
3. **Profile projection.** ✅ **Landed.** `ProfileDto` + `ProfileTier` + `projectProfile` + `resolveProfileTier` at [src/modules/profiles/dto/profile.dto.ts](../src/modules/profiles/dto/profile.dto.ts) and [src/modules/profiles/projection.ts](../src/modules/profiles/projection.ts). `ProfilesService.findPublic`/`search` now take a `Viewer`, enforce visibility (private → 404 non-self/staff; members_only → 404 guests; blocked-pair → 404), and return projected DTOs with batched friend-lookups on search. `@OptionalAuth()` + `@CurrentViewer()` wired on `GET /profiles/:userId`, `GET /profiles/search`, and `GET /users/:id` (which now delegates to `ProfilesService`). `Friendship` and `UserBlock` registered in `ProfilesModule`; `UsersModule` imports `ProfilesModule`.

   **Breaking change:** `GET /users/:id`, `GET /profiles/:userId`, and `GET /profiles/search` previously returned raw `User`/`Profile` rows. They now return `ProfileDto` (or `{items: ProfileDto[], total, page, limit}` for search). Frontend consumers must adapt.
4. **Posts projection.** ✅ **Landed.** `PostsService.activityFeed`/`findOne`/`listTopLevelComments`/`listReplies` now take a `Viewer`. Member-only lenses (`mentions`/`favorites`/`friends`/`groups`) reject guests with 400. `assertVisible` and `applyVisibility` accept a nullable userId: guests get `audience='public'` posts only, no block check (we don't know who they are). `buildPostDtosBatch` skips viewer-specific queries for guests and zeroes `viewerFavorited`/`viewerReaction`; `summarizeReactions` hides `topActors` for guests. `@OptionalAuth()` + `@CurrentViewer()` wired on `GET /users/:userId/activity`, `GET /posts/:id`, `GET /posts/:id/comments`, `GET /comments/:id/replies`. `GET /users/me/favorites` stays auth-required (guests have no favorites).
5. **Groups projection.** ✅ **Landed.** `GroupDto` + `GroupTier` + `projectGroup` + `resolveGroupTier` at [src/modules/groups/dto/group.dto.ts](../src/modules/groups/dto/group.dto.ts) and [src/modules/groups/projection.ts](../src/modules/groups/projection.ts). `GroupsService.findBySlug` and `listForViewer` now take a `Viewer` and return projected DTOs. Tier rules: guests hide `rules` + `memberCount`, see `memberCountBand` instead (`<10` / `10+` / `50+` / `100+` / `500+` / `1000+`); group_member / staff see `rules` + exact `memberCount`; `private` groups → 404 unless active member or staff. `listForViewer` batches one membership lookup for the whole page via `activeMembershipsIn`. `@OptionalAuth()` wired on `GET /groups`, `GET /groups/search`, `GET /groups/:slug`. `GET /groups/me` (my groups) and `GET /groups/:id/members` (roster) stay auth-required per the matrix.

   **Breaking change:** `GET /groups`, `GET /groups/search`, and `GET /groups/:slug` return `GroupDto` (tier-projected) instead of raw `Group` rows. Most fields kept their names; new fields are `tier`, `memberCountBand`. `members` relation is no longer included — use `GET /groups/:id/members` instead.
6. **Cookbook updates.** Every doc gets a "Guest" column added to its route table; cookbook examples show both the authenticated and unauthenticated calls.
7. **Tests.** Per-tier matrix tests for each projection. Specifically: a guest request to a friends-only post returns 404; a guest request to a public post returns the redacted DTO; a member request returns the full DTO; etc.

Each phase ships independently and the build stays green between phases.

---

## Open questions

1. **Profile `members_only` visibility — guest behavior?** Today the column allows `public`, `members_only`, `private`. Suggest: guests see `public` only; members see `public` + `members_only`. ("members_only" is the field's whole purpose.)
2. **City vs country for guests.** Country exposed, city hidden — is that the right knob? Some dating sites do the opposite (city public, exact address private). Whichever the product wants, lock it in before projection lands.
3. **Age bucket for members-not-friends.** "30s" vs exact age — the matrix proposes coarsening; confirm the bucketing rule ("20s/30s/40s/50+" vs "±2 years").
4. **Member-count rounding thresholds for guests.** Proposed: `<10`, `10+`, `50+`, `100+`, `500+`, `1000+`. Anti-enumeration only matters for tiny groups (where the exact count leaks identity); large groups don't need rounding. Maybe just hide it when `< 5` and show exact otherwise.
5. **SEO / indexability.** Guest-readable profile and group pages are great candidates for search-engine indexing. Decide on `robots.txt` and `<meta>` tags at the frontend; the backend just needs to not require auth.
6. **Caching.** Guest GETs are highly cacheable at the CDN. Send `Cache-Control: public, max-age=60` on guest responses; `private, no-store` when the viewer is authenticated (same URL, different shape). This works as long as we **Vary on `Authorization`**, which we should.

---

## What I'd build first if approved

Phase 1 + Phase 3 (just the profile projection) gives the frontend an immediately useful capability — a guest-browseable member directory and profile page — without touching posts or groups. Validate the pattern there, then propagate to posts and groups in follow-ups.
