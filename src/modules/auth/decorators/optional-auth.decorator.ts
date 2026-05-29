import { SetMetadata } from '@nestjs/common';

export const OPTIONAL_AUTH_KEY = 'optional_auth';

/**
 * Mark a route as optional-auth: callers MAY present a bearer token, but the
 * route still runs without one.
 *
 * Semantics:
 * - No `Authorization` header → handler runs with `req.user = undefined`
 *   (use `@CurrentViewer()` to get a guest `Viewer`).
 * - Valid token → handler runs with `req.user` populated, same as default.
 * - Invalid / expired token → 401 (we do not silently degrade to guest;
 *   the frontend needs the signal to refresh).
 *
 * Different from `@Public()`, which skips token *parsing* entirely. Use
 * `@OptionalAuth()` when the handler tiers its response by `viewer.isAuthenticated`.
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);
