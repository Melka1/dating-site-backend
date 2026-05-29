import type { UserRole } from '../modules/users/entities/user.entity';
import type { JwtPayload } from '../modules/auth/types/jwt-payload.type';

/**
 * Coarse request-level identity. Resource-relative tiers (`friend`, `member of
 * this group`, etc.) are computed inside services that already know how to
 * answer those questions; the Viewer just carries the request-time facts.
 *
 * For routes guarded by the default JwtAuthGuard, the Viewer will always be
 * authenticated (use `@CurrentUser('sub')` if you just want the id). For
 * routes marked `@OptionalAuth()` the Viewer may be a guest.
 */
export interface Viewer {
  /** UUID of the authenticated user, or `null` for a guest. */
  userId: string | null;
  /** Email verification state from the JWT, or `null` for guests/unconfirmed. */
  emailConfirmedAt: Date | null;
  /** Global role from `public.users`, or `null` for guests. */
  role: UserRole | null;
  /** Convenience: `userId !== null`. */
  isAuthenticated: boolean;
  /** Convenience: `role` ∈ `moderator`/`admin`. False for guests. */
  isStaff: boolean;
  /** Convenience: `role === 'admin'`. False for guests. */
  isAdmin: boolean;
}

export const GUEST_VIEWER: Viewer = Object.freeze({
  userId: null,
  emailConfirmedAt: null,
  role: null,
  isAuthenticated: false,
  isStaff: false,
  isAdmin: false,
});

export function viewerFromJwt(payload: JwtPayload | undefined): Viewer {
  if (!payload) return GUEST_VIEWER;
  return {
    userId: payload.sub,
    emailConfirmedAt: payload.emailConfirmedAt,
    role: payload.role,
    isAuthenticated: true,
    isStaff: payload.role === 'moderator' || payload.role === 'admin',
    isAdmin: payload.role === 'admin',
  };
}
