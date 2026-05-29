import type { GroupJoinPolicy, GroupVisibility } from '../entities/group.entity';

export type GroupTier = 'guest' | 'member' | 'group_member' | 'staff';

/** Rounded buckets for the `memberCountBand` field shown to guests. */
export type MemberCountBand =
  | '<10'
  | '10+'
  | '50+'
  | '100+'
  | '500+'
  | '1000+';

/**
 * Canonical group projection. Tier-gated fields are null when the viewer
 * doesn't earn them. See docs/guest-access.md → "Group" matrix.
 */
export interface GroupDto {
  tier: GroupTier;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Visible to group_member / staff only. */
  rules: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  visibility: GroupVisibility;
  joinPolicy: GroupJoinPolicy;
  interests: string[];
  country: string | null;
  city: string | null;
  ownerId: string;

  /** Exact count. `null` for guests. */
  memberCount: number | null;
  /** Rounded bucket for guests. `null` for members+. */
  memberCountBand: MemberCountBand | null;
  /** Cap, when set by the owner. */
  maxMembers: number | null;

  /** Up to 6 member profile picture URLs (owner/admins first, then earliest joiners with avatars). */
  memberAvatars: string[];
  /** Rounded "+N" indicator for members beyond the previewed avatars (e.g. "5+", "10+"). Null when none extra. */
  extraMembersBand: string | null;

  createdAt: string;
  updatedAt: string;
}
