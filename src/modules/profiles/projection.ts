import type { Viewer } from '../../common/viewer';
import type { User } from '../users/entities/user.entity';
import type { Profile } from './entities/profile.entity';
import type {
  ActivityBucket,
  AgeBand,
  ProfileDto,
  ProfileTier,
} from './dto/profile.dto';

const BIO_GUEST_PREVIEW = 200;

export interface ProfileTierContext {
  /** Accepted friendship between viewer and target. Caller's responsibility to compute. */
  areFriends: boolean;
}

export function resolveProfileTier(
  viewer: Viewer,
  targetUserId: string,
  ctx: ProfileTierContext,
): ProfileTier {
  if (viewer.userId === targetUserId) return 'self';
  // Staff bypasses gates and gets the full DTO — projection-equivalent to self.
  if (viewer.isStaff) return 'self';
  if (!viewer.isAuthenticated) return 'guest';
  return ctx.areFriends ? 'friend' : 'member';
}

export function projectProfile(
  user: Pick<User, 'id' | 'username' | 'isOnline' | 'lastActiveAt'> & {
    email?: string | null;
  },
  profile: Profile,
  tier: ProfileTier,
): ProfileDto {
  const isSelf = tier === 'self';
  const seesExactPersonal = tier === 'self' || tier === 'friend';
  const seesMemberDetails = tier !== 'guest';

  const ageExact = computeAge(profile.dob);

  return {
    tier,

    userId: user.id,
    username: user.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    coverUrl: profile.coverUrl,
    gender: profile.gender,
    seeking: profile.seeking ?? [],
    relationshipType: profile.relationshipType,
    country: profile.country,
    interests: profile.interests ?? [],
    languages: profile.languages ?? [],
    religion: profile.religion,
    profession: profile.profession,

    city: seesMemberDetails ? profile.city : null,
    heightCm: seesMemberDetails ? profile.heightCm : null,
    weightKg: seesMemberDetails ? profile.weightKg : null,
    hairColor: seesMemberDetails ? profile.hairColor : null,
    eyeColor: seesMemberDetails ? profile.eyeColor : null,
    bodyType: seesMemberDetails ? profile.bodyType : null,
    ethnicity: seesMemberDetails ? profile.ethnicity : null,
    favoritePlaces: seesMemberDetails ? (profile.favoritePlaces ?? []) : [],
    maritalStatus: seesMemberDetails ? profile.maritalStatus : null,
    children: seesMemberDetails ? profile.children : null,
    smoking: seesMemberDetails ? profile.smoking : null,
    drinking: seesMemberDetails ? profile.drinking : null,

    bio: tier === 'guest' ? truncate(profile.bio, BIO_GUEST_PREVIEW) : profile.bio,
    lookingFor:
      tier === 'guest' ? truncate(profile.lookingFor, BIO_GUEST_PREVIEW) : profile.lookingFor,
    likes: tier === 'guest' ? truncate(profile.likes, BIO_GUEST_PREVIEW) : profile.likes,

    age: seesExactPersonal ? ageExact : null,
    ageBand: tier === 'member' ? toAgeBand(ageExact) : null,

    lastActiveAt: seesExactPersonal
      ? user.lastActiveAt?.toISOString() ?? null
      : null,
    isOnline: seesExactPersonal ? user.isOnline : null,
    activityBucket: tier === 'member' ? toActivityBucket(user.lastActiveAt) : null,

    address: isSelf ? profile.address : null,
    email: isSelf ? (user.email ?? null) : null,
    completionScore: isSelf ? profile.completionScore : null,
  };
}

function truncate(value: string | null, n: number): string | null {
  if (value == null) return null;
  if (value.length <= n) return value;
  return `${value.slice(0, n).trimEnd()}…`;
}

function computeAge(dob: string | null): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age >= 0 ? age : null;
}

function toAgeBand(age: number | null): AgeBand | null {
  if (age == null) return null;
  if (age < 25) return '18-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  return '55+';
}

function toActivityBucket(lastActiveAt: Date | null): ActivityBucket | null {
  if (!lastActiveAt) return null;
  const diffMs = Date.now() - lastActiveAt.getTime();
  const day = 86_400_000;
  if (diffMs < day) return 'today';
  if (diffMs < 7 * day) return 'this_week';
  if (diffMs < 30 * day) return 'this_month';
  return 'older';
}

/**
 * Human-readable activity label for list views.
 *
 * Precise relative time is reserved for `friend`/`self` tiers to match
 * `projectProfile`'s privacy model — non-friends get a coarse bucket label
 * instead, so we don't leak exact `lastActiveAt` across the gate.
 */
export function formatActiveLabel(
  tier: ProfileTier,
  isOnline: boolean,
  lastActiveAt: Date | null,
): string | null {
  if (!lastActiveAt) return null;
  const exact = tier === 'self' || tier === 'friend';
  if (exact && isOnline) return 'Online now';
  if (exact) return relativeActiveLabel(lastActiveAt);
  const bucket = toActivityBucket(lastActiveAt);
  switch (bucket) {
    case 'today':
      return 'Active today';
    case 'this_week':
      return 'Active this week';
    case 'this_month':
      return 'Active this month';
    case 'older':
      return 'Active a while ago';
    default:
      return null;
  }
}

function relativeActiveLabel(lastActiveAt: Date): string {
  const diffMs = Date.now() - lastActiveAt.getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return 'Active just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? 'Active a minute ago' : `Active ${min} mins ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? 'Active an hour ago' : `Active ${hr} hrs ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return day === 1 ? 'Active a day ago' : `Active ${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return wk === 1 ? 'Active a week ago' : `Active ${wk} weeks ago`;
  return 'Active a while ago';
}
