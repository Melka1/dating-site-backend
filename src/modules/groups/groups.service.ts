import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import type { Viewer } from '../../common/viewer';
import { StorageService, UploadedFile } from '../../common/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { CreateGroupDto } from './dto/create-group.dto';
import type { GroupDto } from './dto/group.dto';
import { SearchGroupsDto } from './dto/search-groups.dto';
import { SuggestedGroup } from './dto/suggested-groups.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import {
  MEMBER_AVATAR_PREVIEW_LIMIT,
  projectGroup,
  resolveGroupTier,
  toExtraMembersBand,
} from './projection';
import {
  GroupMember,
  GroupMemberRole,
  GroupMemberStatus,
} from './entities/group-member.entity';
import { Group } from './entities/group.entity';

const RESERVED_SLUGS = new Set([
  'admin',
  'admins',
  'api',
  'docs',
  'groups',
  'group',
  'me',
  'new',
  'search',
  'support',
  'help',
  'system',
  'moderator',
  'mod',
]);

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupMember) private readonly members: Repository<GroupMember>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async create(ownerId: string, dto: CreateGroupDto): Promise<Group> {
    const slug = await this.mintUniqueSlug(dto.name);
    const group = this.groups.create({
      slug,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? null,
      rules: dto.rules?.trim() ?? null,
      ownerId,
      visibility: dto.visibility ?? 'public',
      joinPolicy: dto.joinPolicy ?? 'open',
      interests: dto.interests ?? [],
      country: dto.country ?? null,
      city: dto.city ?? null,
      maxMembers: dto.maxMembers ?? null,
    });
    const saved = await this.groups.save(group);
    // Trigger groups_after_insert_seed_owner inserts the owner's group_members row.
    await this.audit.record({
      actorId: ownerId,
      action: 'group.create',
      metadata: { groupId: saved.id, slug: saved.slug },
    });
    return saved;
  }

  async findBySlug(slug: string, viewer: Viewer): Promise<GroupDto> {
    const group = await this.groups.findOne({
      where: { slug, deletedAt: IsNull() },
      relations: ['owner'],
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group.adminSuspendedAt && !viewer.isStaff) {
      throw new NotFoundException('Group not found');
    }

    const isActiveMember = viewer.userId
      ? await this.isActiveMember(group.id, viewer.userId)
      : false;

    // Private groups → 404 unless active member or staff.
    if (group.visibility === 'private' && !isActiveMember && !viewer.isStaff) {
      throw new NotFoundException('Group not found');
    }
    // Unlisted groups are readable directly by slug (anyone with the link),
    // matching baseSearchQuery's semantics. No further gate here.

    const tier = resolveGroupTier(viewer, { isActiveMember });
    const previews = await this.fetchAvatarPreviews([group.id]);
    return projectGroup(group, tier, previews.get(group.id) ?? []);
  }

  async listForViewer(
    viewer: Viewer,
    filters: SearchGroupsDto,
  ): Promise<{ items: GroupDto[]; total: number; page: number; limit: number }> {
    const qb = this.baseSearchQuery(viewer.userId);
    this.applyFilters(qb, filters);
    this.applySort(qb, filters.sort ?? 'newest');
    const page = filters.page;
    const limit = filters.limit;
    qb.skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();

    const groupIds = rows.map((g) => g.id);
    // One batched query for "of these group ids, which is the viewer in?"
    const memberOf = viewer.userId
      ? await this.activeMembershipsIn(viewer.userId, groupIds)
      : new Set<string>();
    const previews = await this.fetchAvatarPreviews(groupIds);

    const items = rows.map((g) =>
      projectGroup(
        g,
        resolveGroupTier(viewer, { isActiveMember: memberOf.has(g.id) }),
        previews.get(g.id) ?? [],
      ),
    );

    return { items, total, page, limit };
  }

  async listMine(viewer: Viewer): Promise<GroupDto[]> {
    const viewerId = viewer.userId!;
    const rows = await this.groups
      .createQueryBuilder('g')
      .innerJoin(
        GroupMember,
        'gm',
        'gm.group_id = g.id AND gm.user_id = :viewerId AND gm.status = :active',
        { viewerId, active: GroupMemberStatus.ACTIVE },
      )
      .where('g.deleted_at IS NULL')
      .andWhere('g.admin_suspended_at IS NULL')
      .orderBy('g.updatedAt', 'DESC')
      .getMany();
    const previews = await this.fetchAvatarPreviews(rows.map((g) => g.id));
    return rows.map((g) =>
      projectGroup(
        g,
        resolveGroupTier(viewer, { isActiveMember: true }),
        previews.get(g.id) ?? [],
      ),
    );
  }

  async suggestGroups(actorId: string, limit = 20): Promise<SuggestedGroup[]> {
    const rows: Array<SuggestedGroup & { score: string | number }> = await this.ds.query(
      `
      with mp as (
        select
          coalesce((select interests from public.profiles where user_id = $1), '{}'::text[]) as interests,
          (select country from public.profiles where user_id = $1) as country,
          (select city    from public.profiles where user_id = $1) as city
      ),
      my_memberships as (
        select group_id from public.group_members where user_id = $1
      ),
      my_friends as (
        select case when user_low = $1 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $1 or user_high = $1)
      ),
      scored as (
        select
          g.id, g.slug, g.name, g.description,
          g.avatar_url as "avatarUrl",
          g.cover_url  as "coverUrl",
          g.visibility,
          g.join_policy as "joinPolicy",
          g.interests, g.country, g.city,
          g.member_count as "memberCount",
          g.max_members  as "maxMembers",
          (select count(*)::int
             from unnest(coalesce(g.interests, '{}'::text[])) x
            where x = any(mp.interests)
          ) as "sharedInterests",
          (case when g.country is not null and g.country = mp.country then 1 else 0 end) as "sameCountry",
          (case when g.city    is not null and g.city    = mp.city    then 1 else 0 end) as "sameCity",
          (select count(*)::int
             from public.group_members gm
             join my_friends f on f.friend_id = gm.user_id
            where gm.group_id = g.id and gm.status = 'active'
          ) as "friendsInGroup"
        from public.groups g
        cross join mp
        where g.deleted_at is null
          and g.admin_suspended_at is null
          and g.visibility = 'public'
          and g.join_policy in ('open', 'approval')
          and (g.max_members is null or g.member_count < g.max_members)
          and g.id not in (select group_id from my_memberships)
      )
      select
        id, slug, name, description,
        "avatarUrl", "coverUrl",
        visibility, "joinPolicy",
        interests, country, city,
        "memberCount", "maxMembers",
        "sharedInterests", "friendsInGroup", "sameCountry", "sameCity",
        ("sharedInterests" * 3 + "friendsInGroup" * 4 + "sameCity" * 3 + "sameCountry" * 2) as score
      from scored
      where ("sharedInterests" + "friendsInGroup" + "sameCity" + "sameCountry") > 0
      order by score desc, "memberCount" desc
      limit $2
      `,
      [actorId, limit],
    );

    const previews = await this.fetchAvatarPreviews(rows.map((r) => r.id));
    return rows.map((r) => {
      const avatars = previews.get(r.id) ?? [];
      const extras = Math.max(0, r.memberCount - avatars.length);
      return {
        ...r,
        score: Number(r.score),
        memberAvatars: avatars,
        extraMembersBand: toExtraMembersBand(extras),
      };
    });
  }

  /**
   * Single-shot group update. JSON fields plus optional `avatar`/`cover`
   * image files on the same multipart request. Uploads happen first so a
   * failed upload short-circuits before mutating state; the previous image
   * is best-effort deleted from storage after the DB save succeeds.
   */
  async patch(
    groupId: string,
    actorId: string,
    dto: UpdateGroupDto,
    avatarFile?: UploadedFile,
    coverFile?: UploadedFile,
  ): Promise<Group> {
    const group = await this.requireGroup(groupId);
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);

    const avatarBucket = this.config.get('supabase.groupAvatarBucket', { infer: true });
    const coverBucket = this.config.get('supabase.groupCoverBucket', { infer: true });

    const prevAvatarUrl = group.avatarUrl;
    const prevCoverUrl = group.coverUrl;
    let newAvatarUrl: string | undefined;
    let newCoverUrl: string | undefined;

    try {
      if (avatarFile) {
        const stored = await this.storage.uploadOne(avatarBucket, groupId, avatarFile, {
          pathPrefix: 'avatar',
          allow: ['photo'],
        });
        newAvatarUrl = stored.url;
      }
      if (coverFile) {
        const stored = await this.storage.uploadOne(coverBucket, groupId, coverFile, {
          pathPrefix: 'cover',
          allow: ['photo'],
        });
        newCoverUrl = stored.url;
      }
    } catch (err) {
      if (newAvatarUrl) {
        await this.deleteByPublicUrl(avatarBucket, newAvatarUrl);
      }
      throw err;
    }

    const before: Partial<Group> = {
      name: group.name,
      description: group.description,
      visibility: group.visibility,
      joinPolicy: group.joinPolicy,
    };
    Object.assign(group, {
      name: dto.name ?? group.name,
      description: dto.description ?? group.description,
      rules: dto.rules ?? group.rules,
      visibility: dto.visibility ?? group.visibility,
      joinPolicy: dto.joinPolicy ?? group.joinPolicy,
      interests: dto.interests ?? group.interests,
      country: dto.country ?? group.country,
      city: dto.city ?? group.city,
      maxMembers: dto.maxMembers ?? group.maxMembers,
      avatarUrl: newAvatarUrl ?? group.avatarUrl,
      coverUrl: newCoverUrl ?? group.coverUrl,
    });
    await this.groups.save(group);

    await this.audit.record({
      actorId,
      action: 'group.update',
      metadata: { groupId, before, after: dto },
    });

    if (newAvatarUrl && prevAvatarUrl && prevAvatarUrl !== newAvatarUrl) {
      await this.deleteByPublicUrl(avatarBucket, prevAvatarUrl);
    }
    if (newCoverUrl && prevCoverUrl && prevCoverUrl !== newCoverUrl) {
      await this.deleteByPublicUrl(coverBucket, prevCoverUrl);
    }

    return group;
  }

  async renameSlug(groupId: string, actorId: string, newSlug: string): Promise<Group> {
    const group = await this.requireGroup(groupId);
    if (group.ownerId !== actorId) {
      throw new ForbiddenException('Only the owner can rename the slug');
    }
    if (RESERVED_SLUGS.has(newSlug.toLowerCase())) {
      throw new ConflictException('Slug is reserved');
    }
    const taken = await this.groups.findOne({ where: { slug: newSlug } });
    if (taken && taken.id !== groupId) {
      throw new ConflictException('Slug is taken');
    }
    const oldSlug = group.slug;
    group.slug = newSlug;
    await this.groups.save(group);
    await this.audit.record({
      actorId,
      action: 'group.rename_slug',
      metadata: { groupId, from: oldSlug, to: newSlug },
    });
    return group;
  }

  async softDelete(groupId: string, actorId: string): Promise<void> {
    const group = await this.requireGroup(groupId);
    if (group.ownerId !== actorId) {
      throw new ForbiddenException('Only the owner can delete a group');
    }
    await this.groups.update({ id: groupId }, { deletedAt: new Date() });
    await this.audit.record({
      actorId,
      action: 'group.soft_delete',
      metadata: { groupId },
    });
  }

  async restore(groupId: string, actorId: string): Promise<Group> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    if (group.ownerId !== actorId) {
      throw new ForbiddenException('Only the owner can restore the group');
    }
    if (!group.deletedAt) return group;
    await this.groups.update({ id: groupId }, { deletedAt: null });
    await this.audit.record({
      actorId,
      action: 'group.restore',
      metadata: { groupId },
    });
    return { ...group, deletedAt: null };
  }

  // ---------------------------------------------------------------------------
  // Membership — open join / approval / invite
  // ---------------------------------------------------------------------------

  async selfJoin(groupId: string, userId: string): Promise<GroupMember> {
    return this.ds.transaction(async (m) => {
      const group = await m
        .getRepository(Group)
        .createQueryBuilder('g')
        .setLock('pessimistic_write')
        .where('g.id = :id', { id: groupId })
        .getOne();
      if (!group || group.deletedAt || group.adminSuspendedAt) {
        throw new NotFoundException('Group not found');
      }
      if (group.joinPolicy !== 'open') {
        throw new ForbiddenException('Group is not open for direct join');
      }
      this.assertCapacity(group);

      const existing = await m
        .getRepository(GroupMember)
        .findOne({ where: { groupId, userId } });
      if (existing) {
        if (existing.status === GroupMemberStatus.BANNED) {
          throw new ForbiddenException('You are banned from this group');
        }
        return existing;
      }
      const row = m.getRepository(GroupMember).create({
        groupId,
        userId,
        role: GroupMemberRole.MEMBER,
        status: GroupMemberStatus.ACTIVE,
      });
      await m.getRepository(GroupMember).save(row);
      return row;
    });
  }

  async requestJoin(groupId: string, userId: string): Promise<GroupMember> {
    const group = await this.requireGroup(groupId);
    if (group.joinPolicy !== 'approval') {
      throw new ForbiddenException('Group does not accept join requests');
    }
    const existing = await this.members.findOne({ where: { groupId, userId } });
    if (existing) {
      if (existing.status === GroupMemberStatus.BANNED) {
        throw new ForbiddenException('You are banned from this group');
      }
      return existing;
    }
    const row = this.members.create({
      groupId,
      userId,
      role: GroupMemberRole.MEMBER,
      status: GroupMemberStatus.PENDING,
    });
    return this.members.save(row);
  }

  async cancelRequest(groupId: string, userId: string): Promise<void> {
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row || row.status !== GroupMemberStatus.PENDING) {
      throw new NotFoundException('No pending request');
    }
    await this.members.delete({ groupId, userId });
  }

  async invite(
    groupId: string,
    actorId: string,
    userIds: string[],
  ): Promise<{ invited: number }> {
    const group = await this.requireGroup(groupId);
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);

    const existing = await this.members.find({
      where: { groupId, userId: In(userIds) },
      select: ['userId'],
    });
    const skip = new Set(existing.map((e) => e.userId));
    const toInsert = userIds
      .filter((id) => !skip.has(id))
      .map((id) =>
        this.members.create({
          groupId,
          userId: id,
          role: GroupMemberRole.MEMBER,
          status: GroupMemberStatus.INVITED,
          invitedBy: actorId,
        }),
      );
    if (toInsert.length === 0) return { invited: 0 };
    await this.members.save(toInsert);
    await this.audit.record({
      actorId,
      action: 'group.invite',
      metadata: { groupId, userIds: toInsert.map((r) => r.userId), groupName: group.name },
    });
    return { invited: toInsert.length };
  }

  async acceptInvite(groupId: string, userId: string): Promise<GroupMember> {
    return this.ds.transaction(async (m) => {
      const row = await m
        .getRepository(GroupMember)
        .findOne({ where: { groupId, userId } });
      if (!row || row.status !== GroupMemberStatus.INVITED) {
        throw new NotFoundException('No pending invite');
      }
      const group = await m
        .getRepository(Group)
        .createQueryBuilder('g')
        .setLock('pessimistic_write')
        .where('g.id = :id', { id: groupId })
        .getOne();
      if (!group || group.deletedAt) throw new NotFoundException('Group not found');
      this.assertCapacity(group);
      row.status = GroupMemberStatus.ACTIVE;
      await m.getRepository(GroupMember).save(row);
      return row;
    });
  }

  async declineInvite(groupId: string, userId: string): Promise<void> {
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row || row.status !== GroupMemberStatus.INVITED) {
      throw new NotFoundException('No pending invite');
    }
    await this.members.delete({ groupId, userId });
  }

  async approve(groupId: string, actorId: string, userId: string): Promise<GroupMember> {
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    return this.ds.transaction(async (m) => {
      const row = await m
        .getRepository(GroupMember)
        .findOne({ where: { groupId, userId } });
      if (!row || row.status !== GroupMemberStatus.PENDING) {
        throw new NotFoundException('No pending request');
      }
      const group = await m
        .getRepository(Group)
        .createQueryBuilder('g')
        .setLock('pessimistic_write')
        .where('g.id = :id', { id: groupId })
        .getOne();
      if (!group) throw new NotFoundException('Group not found');
      this.assertCapacity(group);
      row.status = GroupMemberStatus.ACTIVE;
      await m.getRepository(GroupMember).save(row);
      await this.audit.record({
        actorId,
        targetId: userId,
        action: 'group.approve',
        metadata: { groupId },
      });
      return row;
    });
  }

  async deny(groupId: string, actorId: string, userId: string): Promise<void> {
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row || row.status !== GroupMemberStatus.PENDING) {
      throw new NotFoundException('No pending request');
    }
    await this.members.delete({ groupId, userId });
    await this.audit.record({
      actorId,
      targetId: userId,
      action: 'group.deny',
      metadata: { groupId },
    });
  }

  async leave(groupId: string, userId: string): Promise<void> {
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row) throw new NotFoundException('Not a member');
    if (row.role === GroupMemberRole.OWNER) {
      throw new ConflictException({
        code: 'OWNER_CANNOT_LEAVE',
        message: 'Owners must transfer ownership before leaving',
      });
    }
    await this.members.delete({ groupId, userId });
  }

  async listMembers(
    groupId: string,
    viewerId: string,
    statusFilter?: GroupMemberStatus,
    roleFilter?: GroupMemberRole,
  ): Promise<GroupMember[]> {
    const group = await this.requireGroup(groupId);
    const viewerIsMember = await this.isActiveMember(groupId, viewerId);
    if (!viewerIsMember && group.visibility === 'private') {
      throw new NotFoundException('Group not found');
    }
    // Non-members can only see active roster on public/unlisted groups.
    const effectiveStatus =
      !viewerIsMember ? GroupMemberStatus.ACTIVE : statusFilter ?? undefined;
    const qb = this.members
      .createQueryBuilder('gm')
      .where('gm.group_id = :groupId', { groupId })
      .orderBy('gm.createdAt', 'ASC');
    if (effectiveStatus) qb.andWhere('gm.status = :status', { status: effectiveStatus });
    if (roleFilter) qb.andWhere('gm.role = :role', { role: roleFilter });
    return qb.getMany();
  }

  // ---------------------------------------------------------------------------
  // Moderation
  // ---------------------------------------------------------------------------

  async setRole(
    groupId: string,
    actorId: string,
    targetUserId: string,
    role: GroupMemberRole,
  ): Promise<GroupMember> {
    if (role === GroupMemberRole.OWNER) {
      throw new BadRequestException('Use transfer-owner to change ownership');
    }
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    const row = await this.requireMembership(groupId, targetUserId);
    if (row.role === GroupMemberRole.OWNER) {
      throw new ForbiddenException('Cannot change the owner role');
    }
    const before = row.role;
    row.role = role;
    await this.members.save(row);
    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'group.set_role',
      metadata: { groupId, from: before, to: role },
    });
    return row;
  }

  async kick(groupId: string, actorId: string, targetUserId: string): Promise<void> {
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    const row = await this.requireMembership(groupId, targetUserId);
    if (row.role === GroupMemberRole.OWNER) {
      throw new ForbiddenException('Cannot kick the owner');
    }
    await this.members.delete({ groupId, userId: targetUserId });
    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'group.kick',
      metadata: { groupId, role: row.role },
    });
  }

  async ban(
    groupId: string,
    actorId: string,
    targetUserId: string,
    opts: { until?: string; reason?: string },
  ): Promise<GroupMember> {
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    const row = await this.requireMembership(groupId, targetUserId);
    if (row.role === GroupMemberRole.OWNER) {
      throw new ForbiddenException('Cannot ban the owner');
    }
    row.status = GroupMemberStatus.BANNED;
    row.bannedUntil = opts.until ? new Date(opts.until) : null;
    row.banReason = opts.reason ?? null;
    await this.members.save(row);
    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'group.ban',
      metadata: { groupId, until: opts.until ?? null, reason: opts.reason ?? null },
    });
    return row;
  }

  async unban(groupId: string, actorId: string, targetUserId: string): Promise<GroupMember> {
    await this.requireRole(groupId, actorId, [GroupMemberRole.OWNER, GroupMemberRole.ADMIN]);
    const row = await this.requireMembership(groupId, targetUserId);
    if (row.status !== GroupMemberStatus.BANNED) {
      throw new BadRequestException('Member is not banned');
    }
    row.status = GroupMemberStatus.ACTIVE;
    row.bannedUntil = null;
    row.banReason = null;
    await this.members.save(row);
    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'group.unban',
      metadata: { groupId },
    });
    return row;
  }

  async transferOwner(
    groupId: string,
    currentOwnerId: string,
    newOwnerId: string,
  ): Promise<void> {
    if (currentOwnerId === newOwnerId) {
      throw new BadRequestException('You are already the owner');
    }
    await this.ds.transaction(async (m) => {
      const group = await m.getRepository(Group).findOne({ where: { id: groupId } });
      if (!group) throw new NotFoundException('Group not found');
      if (group.ownerId !== currentOwnerId) {
        throw new ForbiddenException('Only the current owner can transfer ownership');
      }
      const newOwnerRow = await m
        .getRepository(GroupMember)
        .findOne({ where: { groupId, userId: newOwnerId } });
      if (
        !newOwnerRow ||
        newOwnerRow.status !== GroupMemberStatus.ACTIVE ||
        newOwnerRow.role !== GroupMemberRole.ADMIN
      ) {
        throw new BadRequestException('New owner must already be an active admin in the group');
      }
      const currentRow = await m
        .getRepository(GroupMember)
        .findOne({ where: { groupId, userId: currentOwnerId } });
      if (!currentRow) throw new NotFoundException('Owner membership row missing');

      // Demote current owner first so the single-owner trigger doesn't fire.
      currentRow.role = GroupMemberRole.ADMIN;
      await m.getRepository(GroupMember).save(currentRow);

      newOwnerRow.role = GroupMemberRole.OWNER;
      await m.getRepository(GroupMember).save(newOwnerRow);

      group.ownerId = newOwnerId;
      await m.getRepository(Group).save(group);
    });
    await this.audit.record({
      actorId: currentOwnerId,
      targetId: newOwnerId,
      action: 'group.transfer_owner',
      metadata: { groupId },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async mintUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    if (!base || base.length < 3) {
      throw new BadRequestException('Name does not yield a valid slug');
    }
    if (RESERVED_SLUGS.has(base)) {
      throw new ConflictException('Slug is reserved');
    }
    let candidate = base;
    for (let suffix = 2; suffix < 1000; suffix++) {
      const clash = await this.groups.findOne({ where: { slug: candidate } });
      if (!clash) return candidate;
      candidate = `${base}-${suffix}`.slice(0, 40);
    }
    throw new ConflictException('Could not mint a unique slug');
  }

  private baseSearchQuery(viewerId: string | null) {
    const qb = this.groups
      .createQueryBuilder('g')
      .where('g.deleted_at IS NULL')
      .andWhere('g.admin_suspended_at IS NULL');
    if (viewerId) {
      qb.andWhere(
        `(g.visibility IN ('public','unlisted')
          OR EXISTS (
            SELECT 1 FROM group_members gm
             WHERE gm.group_id = g.id
               AND gm.user_id = :viewerId
               AND gm.status = 'active'
          ))`,
        { viewerId },
      );
    } else {
      qb.andWhere(`g.visibility = 'public'`);
    }
    return qb;
  }

  private applyFilters(
    qb: ReturnType<Repository<Group>['createQueryBuilder']>,
    filters: SearchGroupsDto,
  ): void {
    if (filters.country) qb.andWhere('g.country = :country', { country: filters.country });
    if (filters.joinPolicy) qb.andWhere('g.join_policy = :jp', { jp: filters.joinPolicy });
    if (filters.interests?.length) {
      qb.andWhere('g.interests && :interests::text[]', { interests: filters.interests });
    }
    if (filters.q) qb.andWhere('g.name % :q', { q: filters.q });
  }

  private applySort(
    qb: ReturnType<Repository<Group>['createQueryBuilder']>,
    sort: NonNullable<SearchGroupsDto['sort']>,
  ): void {
    switch (sort) {
      case 'largest':
        qb.orderBy('g.memberCount', 'DESC');
        break;
      case 'most_active':
        qb.orderBy('g.updatedAt', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('g.createdAt', 'DESC');
    }
  }

  private assertCapacity(group: Group): void {
    if (group.maxMembers != null && group.memberCount >= group.maxMembers) {
      throw new ConflictException({ code: 'GROUP_FULL', message: 'Group is at capacity' });
    }
  }

  private async requireGroup(groupId: string): Promise<Group> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group || group.deletedAt) throw new NotFoundException('Group not found');
    return group;
  }

  private async requireMembership(groupId: string, userId: string): Promise<GroupMember> {
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row) throw new NotFoundException('Member not found');
    return row;
  }

  private async requireRole(
    groupId: string,
    userId: string,
    allowed: GroupMemberRole[],
  ): Promise<GroupMember> {
    const row = await this.members.findOne({ where: { groupId, userId } });
    if (!row || row.status !== GroupMemberStatus.ACTIVE || !allowed.includes(row.role)) {
      throw new ForbiddenException('Insufficient group permissions');
    }
    return row;
  }

  private async isActiveMember(groupId: string, userId: string): Promise<boolean> {
    const row = await this.members.findOne({
      where: { groupId, userId, status: GroupMemberStatus.ACTIVE },
      select: ['userId'],
    });
    return !!row;
  }

  /** Subset of `groupIds` the user is an active member of. */
  private async activeMembershipsIn(
    userId: string,
    groupIds: string[],
  ): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();
    const rows = await this.members.find({
      where: {
        userId,
        groupId: In(groupIds),
        status: GroupMemberStatus.ACTIVE,
      },
      select: ['groupId'],
    });
    return new Set(rows.map((r) => r.groupId));
  }

  /**
   * Returns up to MEMBER_AVATAR_PREVIEW_LIMIT avatar URLs per group for
   * the given ids. Ordering: owner → admin → moderator → member, then
   * earliest joined first. Members without a profile avatar are skipped.
   */
  private async fetchAvatarPreviews(groupIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (groupIds.length === 0) return out;
    const rows: Array<{ group_id: string; avatar_url: string }> = await this.ds.query(
      `
      with ranked as (
        select
          gm.group_id,
          p.avatar_url,
          row_number() over (
            partition by gm.group_id
            order by
              case gm.role
                when 'owner' then 0
                when 'admin' then 1
                when 'moderator' then 2
                else 3
              end,
              coalesce(gm.joined_at, gm.created_at) asc
          ) as rn
        from public.group_members gm
        join public.profiles p on p.user_id = gm.user_id
        where gm.group_id = any($1::uuid[])
          and gm.status = 'active'
          and p.avatar_url is not null
      )
      select group_id, avatar_url
      from ranked
      where rn <= $2
      order by group_id, rn
      `,
      [groupIds, MEMBER_AVATAR_PREVIEW_LIMIT],
    );
    for (const r of rows) {
      const arr = out.get(r.group_id);
      if (arr) arr.push(r.avatar_url);
      else out.set(r.group_id, [r.avatar_url]);
    }
    return out;
  }

  private async deleteByPublicUrl(bucket: string, url: string): Promise<void> {
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return;
    const path = url.slice(idx + marker.length);
    await this.storage.delete(bucket, path).catch(() => undefined);
  }
}

function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
