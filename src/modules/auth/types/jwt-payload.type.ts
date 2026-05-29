import type { UserRole } from '../../users/entities/user.entity';

/**
 * The decorated user attached to `request.user` after JwtAuthGuard.
 * `sub`, `email`, and `email_confirmed_at` come from the Supabase-signed
 * access token; `role` is loaded from `public.users` so we see role upgrades
 * without requiring a token refresh.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  emailConfirmedAt: Date | null;
  role: UserRole;
}

/** Raw claims inside a Supabase-issued JWT (only what we read). */
export interface SupabaseJwtClaims {
  sub: string;
  email?: string;
  aud?: string;
  role?: string;
  /** Legacy HS256 tokens only; new asymmetric tokens omit this. */
  email_confirmed_at?: string | null;
  /** Some token versions surface this at the root. */
  email_verified?: boolean;
  user_metadata?: {
    email_verified?: boolean;
    email_confirmed_at?: string | null;
    [k: string]: unknown;
  };
  app_metadata?: Record<string, unknown>;
}
