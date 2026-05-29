import type { Viewer } from '../../common/viewer';
import type { Group } from './entities/group.entity';
import type { GroupDto, GroupTier, MemberCountBand } from './dto/group.dto';

export const MEMBER_AVATAR_PREVIEW_LIMIT = 6;

export interface GroupTierContext {
  /** Viewer is an active member of *this* group. */
  isActiveMember: boolean;
}

export function resolveGroupTier(viewer: Viewer, ctx: GroupTierContext): GroupTier {
  if (viewer.isStaff) return 'staff';
  if (!viewer.isAuthenticated) return 'guest';
  if (ctx.isActiveMember) return 'group_member';
  return 'member';
}

export function projectGroup(
  group: Group,
  tier: GroupTier,
  memberAvatars: string[] = [],
): GroupDto {
  const seesInternal = tier === 'group_member' || tier === 'staff';
  const seesExactCount = tier !== 'guest';

  const avatars = memberAvatars.slice(0, MEMBER_AVATAR_PREVIEW_LIMIT);
  const extras = Math.max(0, group.memberCount - avatars.length);

  return {
    tier,
    id: group.id,
    slug: group.slug,
    name: group.name,
    description: group.description,
    rules: seesInternal ? group.rules : null,
    avatarUrl: group.avatarUrl,
    coverUrl: group.coverUrl,
    visibility: group.visibility,
    joinPolicy: group.joinPolicy,
    interests: group.interests ?? [],
    country: group.country,
    city: group.city,
    ownerId: group.ownerId,

    memberCount: seesExactCount ? group.memberCount : null,
    memberCountBand: seesExactCount ? null : toMemberCountBand(group.memberCount),
    maxMembers: group.maxMembers,

    memberAvatars: avatars,
    extraMembersBand: toExtraMembersBand(extras),

    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

function toMemberCountBand(n: number): MemberCountBand {
  if (n < 10) return '<10';
  if (n < 50) return '10+';
  if (n < 100) return '50+';
  if (n < 500) return '100+';
  if (n < 1000) return '500+';
  return '1000+';
}

const EXTRA_BUCKETS = [1000, 500, 100, 50, 20, 10, 5, 1];

export function toExtraMembersBand(n: number): string | null {
  if (n <= 0) return null;
  for (const b of EXTRA_BUCKETS) {
    if (n >= b) return `${b}+`;
  }
  return null;
}
