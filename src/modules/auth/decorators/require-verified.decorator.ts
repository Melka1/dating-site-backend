import { SetMetadata } from '@nestjs/common';

export const REQUIRE_VERIFIED_KEY = 'require_verified';

/**
 * Mark a route (or controller) as requiring a verified email.
 * Enforced by {@link EmailVerifiedGuard}.
 */
export const RequireVerified = () => SetMetadata(REQUIRE_VERIFIED_KEY, true);
