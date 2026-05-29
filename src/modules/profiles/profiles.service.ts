import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import type { Viewer } from '../../common/viewer';
import { StorageService, UploadedFile } from '../../common/storage/storage.service';
import { Friendship, FriendshipStatus } from '../friends/entities/friendship.entity';
import { UserBlock } from '../friends/entities/user-block.entity';
import { AccountStatus, User } from '../users/entities/user.entity';
import type { NewMembersDto } from './dto/new-members.dto';
import type { ProfileDto } from './dto/profile.dto';
import type { ProfileSort, SearchProfilesDto } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Profile } from './entities/profile.entity';
import { formatActiveLabel, projectProfile, resolveProfileTier } from './projection';

const NEW_MEMBERS_WINDOW_DAYS = 7;

export interface NewMemberItem extends ProfileDto {
  joinedAt: string;
  activeLabel: string | null;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof Profile> = [
  'displayName',
  'gender',
  'seeking',
  'dob',
  'country',
  'avatarUrl',
  'bio',
];

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
    @InjectRepository(UserBlock) private readonly blocks: Repository<UserBlock>,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async findMe(userId: string): Promise<Profile> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  /**
   * Fetch a single profile, applying visibility gates and projecting per
   * viewer tier. Returns 404 for any case the viewer isn't allowed to see —
   * never leaks "exists but private" by status code.
   */
  async findPublic(userId: string, viewer: Viewer): Promise<ProfileDto> {
    const profile = await this.profiles.findOne({
      where: { userId },
      relations: ['user'],
    });
    if (!profile || !profile.user) throw new NotFoundException('Profile not found');

    const isSelf = viewer.userId === profile.userId;
    const isStaff = viewer.isStaff;

    if (!isSelf && !isStaff) {
      if (profile.user.accountStatus !== AccountStatus.ACTIVE) {
        throw new NotFoundException('Profile not found');
      }
      if (profile.visibility === 'private') {
        throw new NotFoundException('Profile not found');
      }
      if (profile.visibility === 'members_only' && !viewer.isAuthenticated) {
        throw new NotFoundException('Profile not found');
      }
      if (viewer.userId && (await this.isBlockedPair(viewer.userId, profile.userId))) {
        throw new NotFoundException('Profile not found');
      }
    }

    const areFriends =
      !isSelf && viewer.userId
        ? await this.areAcceptedFriends(viewer.userId, profile.userId)
        : false;

    const tier = resolveProfileTier(viewer, profile.userId, { areFriends });
    return projectProfile(profile.user, profile, tier);
  }

  /**
   * Single-shot profile update. Accepts the JSON fields plus optional
   * `avatar`/`cover` image files on the same multipart request. Uploads
   * happen first (outside the DB write) so a failed upload short-circuits
   * before mutating state; the previous image, if any, is best-effort
   * deleted from storage *after* the save succeeds.
   */
  async patchMe(
    userId: string,
    dto: UpdateProfileDto,
    avatarFile?: UploadedFile,
    coverFile?: UploadedFile,
  ): Promise<Profile> {
    const existing = await this.profiles.findOne({ where: { userId } });
    if (!existing) throw new NotFoundException('Profile not found');

    const avatarBucket = this.config.get('supabase.avatarBucket', { infer: true });
    const coverBucket = this.config.get('supabase.coverBucket', { infer: true });

    const prevAvatarUrl = existing.avatarUrl;
    const prevCoverUrl = existing.coverUrl;
    let newAvatarUrl: string | undefined;
    let newCoverUrl: string | undefined;

    try {
      if (avatarFile) {
        const stored = await this.storage.uploadOne(avatarBucket, userId, avatarFile, {
          pathPrefix: 'avatar',
          allow: ['photo'],
        });
        newAvatarUrl = stored.url;
      }
      if (coverFile) {
        const stored = await this.storage.uploadOne(coverBucket, userId, coverFile, {
          pathPrefix: 'cover',
          allow: ['photo'],
        });
        newCoverUrl = stored.url;
      }
    } catch (err) {
      // Best-effort cleanup of an avatar already uploaded if the cover then failed.
      if (newAvatarUrl) {
        await this.deleteByPublicUrl(avatarBucket, newAvatarUrl);
      }
      throw err;
    }

    const next = this.profiles.merge(existing, dto as Partial<Profile>);
    if (newAvatarUrl) next.avatarUrl = newAvatarUrl;
    if (newCoverUrl) next.coverUrl = newCoverUrl;
    next.completionScore = this.scoreCompletion(next);
    await this.profiles.save(next);

    const required = REQUIRED_FIELDS.every((f) => hasValue(next[f]));
    await this.users.update({ id: userId }, { onboardingCompleted: required });

    // Post-commit storage cleanup. Best-effort.
    if (newAvatarUrl && prevAvatarUrl && prevAvatarUrl !== newAvatarUrl) {
      await this.deleteByPublicUrl(avatarBucket, prevAvatarUrl);
    }
    if (newCoverUrl && prevCoverUrl && prevCoverUrl !== newCoverUrl) {
      await this.deleteByPublicUrl(coverBucket, prevCoverUrl);
    }

    return next;
  }

  /**
   * Discovery feed of recently-signed-up members. A "new member" is an
   * onboarded, active, non-deleted account created within the last 7 days,
   * ordered most-recent-first. Applies the same visibility/block gates as
   * `search`, then attaches a human-readable `activeLabel` for the UI.
   */
  async findNew(
    dto: NewMembersDto,
    viewer: Viewer,
  ): Promise<{ items: NewMemberItem[] }> {
    const visibilityIn = viewer.isAuthenticated
      ? `('public','members_only')`
      : `('public')`;

    const cutoff = new Date(Date.now() - NEW_MEMBERS_WINDOW_DAYS * 86_400_000);

    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoinAndSelect('p.user', 'u')
      .where('u.account_status = :active', { active: AccountStatus.ACTIVE })
      .andWhere('u.deleted_at IS NULL')
      .andWhere('u.onboarding_completed = true')
      .andWhere('u.created_at >= :cutoff', { cutoff })
      .andWhere(`p.visibility IN ${visibilityIn}`);

    if (viewer.userId) {
      qb.andWhere('u.id <> :viewerId', { viewerId: viewer.userId });
      qb.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = :viewerId AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id        AND b.blocked_id = :viewerId)
        )`,
        { viewerId: viewer.userId },
      );
    }

    qb.orderBy('u.createdAt', 'DESC').take(dto.limit);

    const rows = await qb.getMany();

    const friendIds = viewer.userId
      ? await this.friendsFromList(
          viewer.userId,
          rows.map((r) => r.userId),
        )
      : new Set<string>();

    const items: NewMemberItem[] = rows
      .filter((p) => !!p.user)
      .map((p) => {
        const tier = resolveProfileTier(viewer, p.userId, {
          areFriends: friendIds.has(p.userId),
        });
        const projected = projectProfile(p.user!, p, tier);
        return {
          ...projected,
          joinedAt: p.user!.createdAt.toISOString(),
          activeLabel: formatActiveLabel(tier, p.user!.isOnline, p.user!.lastActiveAt),
        };
      });

    return { items };
  }

  async search(
    filters: SearchProfilesDto,
    viewer: Viewer,
  ): Promise<{ items: ProfileDto[]; page: number; limit: number; total: number }> {
    // Guests see `public` only; members see `public` + `members_only`.
    const visibilityIn = viewer.isAuthenticated
      ? `('public','members_only')`
      : `('public')`;

    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoinAndSelect('p.user', 'u')
      .where('u.account_status = :active', { active: AccountStatus.ACTIVE })
      .andWhere(`p.visibility IN ${visibilityIn}`);

    if (viewer.userId) {
      qb.andWhere('u.id <> :viewerId', { viewerId: viewer.userId });
      // Drop authored-by-someone-the-viewer-has-blocked-or-is-blocked-by.
      qb.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = :viewerId AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id        AND b.blocked_id = :viewerId)
        )`,
        { viewerId: viewer.userId },
      );
    }

    // Mutual matching: `filters.gender` is the viewer's own gender and
    // `filters.seeking` is the gender(s) the viewer wants. We surface
    // candidates whose gender is in the viewer's seeking list AND whose
    // seeking includes the viewer's gender (or the 'any' wildcard).
    if (filters.seeking?.length) {
      qb.andWhere('p.gender = ANY(:wantedGenders::text[])', {
        wantedGenders: filters.seeking,
      });
    }
    if (filters.gender) {
      qb.andWhere(`p.seeking && ARRAY[:viewerGender, 'any']::text[]`, {
        viewerGender: filters.gender,
      });
    }
    if (filters.interests?.length) {
      qb.andWhere('p.interests && :interests::text[]', { interests: filters.interests });
    }
    if (filters.country) qb.andWhere('p.country = :country', { country: filters.country });
    if (filters.city) qb.andWhere('lower(p.city) = lower(:city)', { city: filters.city });
    if (filters.profession?.length) {
      qb.andWhere('p.profession = ANY(:professions::text[])', {
        professions: filters.profession,
      });
    }

    if (filters.minAge != null) {
      qb.andWhere('p.dob <= :maxDob', { maxDob: dobCutoff(filters.minAge) });
    }
    if (filters.maxAge != null) {
      qb.andWhere('p.dob >= :minDob', { minDob: dobCutoff(filters.maxAge + 1) });
    }
    if (filters.q) {
      qb.andWhere('p.display_name % :q', { q: filters.q });
    }
    if (filters.online) {
      qb.andWhere('u.is_online = true');
    }

    this.applySort(qb, filters.sort ?? 'newest');

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();

    // One round of friend lookups for the whole page when authenticated.
    const friendIds = viewer.userId
      ? await this.friendsFromList(
          viewer.userId,
          rows.map((r) => r.userId),
        )
      : new Set<string>();

    const items = rows
      .filter((p) => !!p.user)
      .map((p) => {
        const tier = resolveProfileTier(viewer, p.userId, {
          areFriends: friendIds.has(p.userId),
        });
        return projectProfile(p.user!, p, tier);
      });

    return { items, total, page, limit };
  }

  private applySort(
    qb: ReturnType<Repository<Profile>['createQueryBuilder']>,
    sort: ProfileSort,
  ): void {
    switch (sort) {
      case 'most_active':
        qb.orderBy('u.lastActiveAt', 'DESC', 'NULLS LAST');
        break;
      case 'popular':
        qb.orderBy('p.completionScore', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('p.createdAt', 'DESC');
    }
  }

  private scoreCompletion(p: Profile): number {
    const weights: Array<[keyof Profile | 'bio_long', number]> = [
      ['displayName', 15],
      ['gender', 10],
      ['seeking', 10],
      ['dob', 15],
      ['country', 10],
      ['avatarUrl', 20],
      ['bio_long', 20],
    ];
    let score = 0;
    for (const [field, weight] of weights) {
      if (field === 'bio_long') {
        if ((p.bio ?? '').trim().length >= 20) score += weight;
      } else if (hasValue(p[field])) {
        score += weight;
      }
    }
    return Math.min(100, score);
  }

  private async areAcceptedFriends(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const [low, high] = a < b ? [a, b] : [b, a];
    const row = await this.friendships.findOne({
      where: { userLow: low, userHigh: high, status: FriendshipStatus.ACCEPTED },
      select: ['userLow'],
    });
    return !!row;
  }

  private async isBlockedPair(a: string, b: string): Promise<boolean> {
    const row = await this.blocks.findOne({
      where: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
      select: ['blockerId'],
    });
    return !!row;
  }

  /** Of `candidateUserIds`, which are accepted friends of `viewerId`. */
  private async friendsFromList(
    viewerId: string,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (candidateUserIds.length === 0) return new Set();
    const rows: Array<{ user_low: string; user_high: string }> = await this.friendships
      .createQueryBuilder('f')
      .select(['f.user_low AS user_low', 'f.user_high AS user_high'])
      .where('f.status = :status', { status: FriendshipStatus.ACCEPTED })
      .andWhere(
        `((f.user_low = :viewerId  AND f.user_high = ANY(:ids))
          OR (f.user_high = :viewerId AND f.user_low  = ANY(:ids)))`,
        { viewerId, ids: candidateUserIds },
      )
      .getRawMany();
    const friends = new Set<string>();
    for (const r of rows) {
      friends.add(r.user_low === viewerId ? r.user_high : r.user_low);
    }
    return friends;
  }

  private async deleteByPublicUrl(bucket: string, url: string): Promise<void> {
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return;
    const path = url.slice(idx + marker.length);
    await this.storage.delete(bucket, path).catch(() => undefined);
  }
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function dobCutoff(ageYears: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - ageYears);
  return d.toISOString().slice(0, 10);
}
