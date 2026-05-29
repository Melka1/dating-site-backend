import type {
  Children,
  Drinking,
  Gender,
  MaritalStatus,
  Profession,
  RelationshipType,
  Smoking,
} from '../entities/profile.entity';

/**
 * Resource-relative viewer tier for a profile. Resolved per-request by
 * combining the request-level Viewer with a friend-of-target check.
 */
export type ProfileTier = 'guest' | 'member' | 'friend' | 'self';

export type AgeBand = '18-24' | '25-34' | '35-44' | '45-54' | '55+';
export type ActivityBucket = 'today' | 'this_week' | 'this_month' | 'older';

/**
 * Single canonical shape for every projection. Fields the viewer's tier
 * doesn't earn are `null` (or empty arrays). The same DTO comes back for
 * `/users/:id`, `/profiles/:userId`, and items in `/profiles/search`.
 *
 * The frontend renders whatever it gets and treats `null` as "not visible
 * to me" — there's no second shape to match against.
 */
export interface ProfileDto {
  /** Resource-relative tier the response was projected at. */
  tier: ProfileTier;

  // ---- always shown ----
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  gender: Gender | null;
  seeking: string[];
  relationshipType: RelationshipType | null;
  country: string | null;
  interests: string[];
  languages: string[];
  religion: string | null;
  profession: Profession | null;

  // ---- member+ ----
  city: string | null;
  heightCm: number | null;
  weightKg: number | null;
  hairColor: string | null;
  eyeColor: string | null;
  bodyType: string | null;
  ethnicity: string | null;
  favoritePlaces: string[];
  maritalStatus: MaritalStatus | null;
  children: Children | null;
  smoking: Smoking | null;
  drinking: Drinking | null;

  // ---- truncated for guests, full for members+ ----
  bio: string | null;
  lookingFor: string | null;
  likes: string | null;

  // ---- coarsened for member, exact for friend/self ----
  /** Exact age. `null` for guests and members; populated for friend/self. */
  age: number | null;
  /** Bucketed age. Populated for members only; `null` for the other tiers. */
  ageBand: AgeBand | null;

  /** Exact `lastActiveAt` (ISO). Populated for friend/self only. */
  lastActiveAt: string | null;
  /** Exact online flag. Populated for friend/self only. */
  isOnline: boolean | null;
  /** Coarsened recency bucket. Populated for members only. */
  activityBucket: ActivityBucket | null;

  // ---- self only ----
  address: string | null;
  email: string | null;
  completionScore: number | null;
}
