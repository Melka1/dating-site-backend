import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  Not,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import {
  StorageService,
  StoredFile,
  UploadedFile,
} from '../../common/storage/storage.service';
import type { Viewer } from '../../common/viewer';
import { AuditService } from '../audit/audit.service';
import { Friendship, FriendshipStatus } from '../friends/entities/friendship.entity';
import { UserBlock } from '../friends/entities/user-block.entity';
import {
  GroupMember,
  GroupMemberStatus,
} from '../groups/entities/group-member.entity';
import { Group } from '../groups/entities/group.entity';
import { User } from '../users/entities/user.entity';
import { ActivityFeedQueryDto, ActivityLens } from './dto/activity-feed.dto';
import {
  CreateCommentDto,
  ListCommentsDto,
  UpdateCommentDto,
} from './dto/comment.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import type {
  UserMediaItemDto,
  UserMediaQueryDto,
  UserMediaResponse,
} from './dto/user-media.dto';
import { Comment } from './entities/comment.entity';
import { PostAttachment } from './entities/post-attachment.entity';
import { PostFavorite } from './entities/post-favorite.entity';
import { PostMention } from './entities/post-mention.entity';
import { Post, PostAudience } from './entities/post.entity';
import { Reaction, ReactionType } from './entities/reaction.entity';

const MENTION_REGEX = /@([a-zA-Z0-9_-]{3,24})/g;
const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface PostAuthorDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PostAttachmentDto {
  id: string;
  kind: 'photo' | 'video';
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  displayOrder: number;
}

export interface ReactionSummaryDto {
  total: number;
  byType: Partial<Record<ReactionType, number>>;
  topActors: PostAuthorDto[];
  viewerReaction: ReactionType | null;
}

export interface PostDto {
  id: string;
  author: PostAuthorDto;
  audience: PostAudience;
  group: { id: string; slug: string; name: string } | null;
  body: string | null;
  attachments: PostAttachmentDto[];
  mentions: { userId: string; username: string }[];
  reactionSummary: ReactionSummaryDto;
  commentCount: number;
  viewerFavorited: boolean;
  isDeleted: boolean;
  editedAt: string | null;
  createdAt: string;
}

export interface CommentDto {
  id: string;
  postId: string;
  parentId: string | null;
  author: PostAuthorDto;
  body: string | null;
  replyCount: number;
  isDeleted: boolean;
  editedAt: string | null;
  createdAt: string;
}

interface RecentCursor {
  createdAt: string;
  id: string;
}

interface PopularCursor {
  score: number;
  id: string;
}

interface MediaCursor {
  postCreatedAt: string;
  attachmentId: string;
}

@Injectable()
export class PostsService {
  constructor(
    @InjectRepository(Post) private readonly posts: Repository<Post>,
    @InjectRepository(PostAttachment)
    private readonly attachments: Repository<PostAttachment>,
    @InjectRepository(PostMention)
    private readonly mentions: Repository<PostMention>,
    @InjectRepository(Reaction) private readonly reactions: Repository<Reaction>,
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(PostFavorite)
    private readonly favorites: Repository<PostFavorite>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly members: Repository<GroupMember>,
    @InjectRepository(Friendship)
    private readonly friendships: Repository<Friendship>,
    @InjectRepository(UserBlock) private readonly blocks: Repository<UserBlock>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------------------------------------------------------------------------
  // Posts CRUD
  // ---------------------------------------------------------------------------

  async create(
    authorId: string,
    dto: CreatePostDto,
    files: UploadedFile[] = [],
  ): Promise<PostDto> {
    this.assertAudienceGroupConsistency(dto.audience, dto.groupId);

    if (dto.audience === 'group' && dto.groupId) {
      await this.assertGroupMember(dto.groupId, authorId);
    }

    // Upload first — before opening the DB transaction. If a file fails to
    // upload we don't want a half-open transaction. StorageService.uploadMany
    // already best-effort cleans up partial batches on its own failure.
    let uploaded: StoredFile[] = [];
    if (files.length > 0) {
      const bucket = this.config.get('supabase.postMediaBucket', { infer: true });
      uploaded = await this.storage.uploadMany(bucket, authorId, files, {
        pathPrefix: 'post',
      });
    }

    try {
      // Do the writes inside the transaction, project AFTER commit. Calling
      // buildPostDto inside the transaction would read via this.posts (default
      // connection) and miss the uncommitted insert → "Post not found".
      const savedId = await this.ds.transaction(async (m) => {
        const post = m.getRepository(Post).create({
          authorId,
          audience: dto.audience,
          groupId: dto.audience === 'group' ? (dto.groupId ?? null) : null,
          body: dto.body.trim(),
        });
        const saved = await m.getRepository(Post).save(post);

        if (uploaded.length > 0) {
          const rows = uploaded.map((u, idx) =>
            m.getRepository(PostAttachment).create({
              postId: saved.id,
              kind: u.kind,
              url: u.url,
              thumbnailUrl: null,
              width: null,
              height: null,
              displayOrder: idx,
            }),
          );
          await m.getRepository(PostAttachment).save(rows);
        }

        const mentionedIds = await this.resolveMentions(saved.body ?? '', authorId);
        if (mentionedIds.length > 0) {
          await m
            .getRepository(PostMention)
            .save(mentionedIds.map((userId) => ({ postId: saved.id, userId })));
        }

        return saved.id;
      });

      await this.audit.record({
        actorId: authorId,
        action: 'post.create',
        metadata: { postId: savedId, audience: dto.audience },
      });

      return this.buildPostDto(savedId, authorId);
    } catch (err) {
      // DB write failed after files were uploaded — clean up to avoid orphans.
      const bucket = this.config.get('supabase.postMediaBucket', { infer: true });
      for (const u of uploaded) {
        await this.storage.delete(bucket, u.path).catch(() => undefined);
      }
      throw err;
    }
  }

  async findOne(postId: string, viewer: Viewer): Promise<PostDto> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertVisible(post, viewer);
    return this.buildPostDto(post.id, viewer);
  }

  /**
   * Gallery view: every post-attachment authored by `targetUserId` that the
   * viewer can see. Visibility cascades from the parent post — guests get
   * attachments from public posts only; members get the full set per the
   * standard visibility chain; private/friends-only/group posts only surface
   * to the right audience.
   */
  async userMedia(
    targetUserId: string,
    viewer: Viewer,
    query: UserMediaQueryDto,
  ): Promise<UserMediaResponse> {
    const limit = query.limit ?? 20;

    const qb = this.attachments
      .createQueryBuilder('pa')
      .innerJoin(Post, 'p', 'p.id = pa.post_id')
      .where('p.author_id = :targetUserId', { targetUserId })
      .andWhere('p.deleted_at IS NULL');

    this.applyVisibility(qb, viewer.userId);

    if (query.kind) {
      qb.andWhere('pa.kind = :kind', { kind: query.kind });
    }

    if (query.cursor) {
      const decoded = decodeCursor<MediaCursor>(query.cursor);
      qb.andWhere('(p.created_at, pa.id) < (:cAt, :cId)', {
        cAt: decoded.postCreatedAt,
        cId: decoded.attachmentId,
      });
    }

    qb.addSelect('p.created_at', 'p_created_at')
      .orderBy('p.createdAt', 'DESC')
      .addOrderBy('pa.id', 'DESC')
      .take(limit + 1);

    // We need both the attachment row and the post.created_at — use
    // getRawAndEntities so the join column is reachable for the cursor.
    const result = await qb.getRawAndEntities<{ p_created_at: string }>();
    const entities = result.entities;
    const raws = result.raw;
    const hasMore = entities.length > limit;
    const slice = hasMore ? entities.slice(0, limit) : entities;

    const items: UserMediaItemDto[] = slice.map((pa, idx) => ({
      attachmentId: pa.id,
      postId: pa.postId,
      kind: pa.kind,
      url: pa.url,
      thumbnailUrl: pa.thumbnailUrl,
      width: pa.width,
      height: pa.height,
      postCreatedAt: new Date(raws[idx].p_created_at).toISOString(),
    }));

    const lastEntity = slice[slice.length - 1];
    const lastRaw = raws[slice.length - 1];
    const nextCursor =
      hasMore && lastEntity
        ? encodeCursor<MediaCursor>({
            postCreatedAt: new Date(lastRaw.p_created_at).toISOString(),
            attachmentId: lastEntity.id,
          })
        : null;

    return { items, nextCursor };
  }

  async patch(postId: string, actorId: string, dto: UpdatePostDto): Promise<PostDto> {
    const post = await this.requireOwnPost(postId, actorId);
    if (post.deletedAt) throw new NotFoundException('Post not found');

    if (dto.audience && dto.audience !== post.audience) {
      // Cannot move into/out of 'group' once created (group_id immutable).
      if (dto.audience === 'group' || post.audience === 'group') {
        throw new BadRequestException('Cannot change audience between group and non-group');
      }
      post.audience = dto.audience;
    }

    if (dto.body !== undefined) {
      const trimmed = dto.body.trim();
      if (trimmed.length === 0) {
        throw new BadRequestException('Body cannot be empty');
      }
      post.body = trimmed;
      post.editedAt = new Date();

      // Re-extract mentions
      await this.ds.transaction(async (m) => {
        await m.getRepository(PostMention).delete({ postId });
        const mentionedIds = await this.resolveMentions(trimmed, actorId);
        if (mentionedIds.length > 0) {
          await m
            .getRepository(PostMention)
            .save(mentionedIds.map((userId) => ({ postId, userId })));
        }
        await m.getRepository(Post).save(post);
      });
    } else {
      await this.posts.save(post);
    }

    return this.buildPostDto(postId, actorId);
  }

  async softDelete(postId: string, actorId: string): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');

    const canDelete =
      post.authorId === actorId ||
      (post.audience === 'group' &&
        post.groupId != null &&
        (await this.isGroupAdminOrOwner(post.groupId, actorId)));
    if (!canDelete) throw new ForbiddenException('Cannot delete this post');

    post.deletedAt = new Date();
    post.body = null;
    await this.posts.save(post);

    await this.audit.record({
      actorId,
      targetId: post.authorId,
      action: 'post.soft_delete',
      metadata: { postId },
    });
  }

  // ---------------------------------------------------------------------------
  // Activity feed (lenses)
  // ---------------------------------------------------------------------------

  async activityFeed(
    targetUserId: string,
    viewer: Viewer,
    query: ActivityFeedQueryDto,
  ): Promise<{ items: PostDto[]; nextCursor: string | null }> {
    const limit = query.limit ?? 20;
    const lens = query.lens ?? 'personal';
    const sort = query.sort ?? 'recent';

    // Member-relative lenses are meaningless without an authenticated viewer.
    // 'personal' is target-relative (the userId in the URL) so guests can hit it.
    if (!viewer.isAuthenticated && lens !== 'personal') {
      throw new BadRequestException(
        `Lens '${lens}' requires authentication`,
      );
    }

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.deleted_at IS NULL');

    this.applyLens(qb, lens, targetUserId, viewer.userId);
    this.applyVisibility(qb, viewer.userId);

    if (sort === 'popular') {
      this.applyPopularSort(qb, query.cursor, limit);
    } else {
      // 'recent' and 'relevant' (placeholder) both fall back to recency.
      this.applyRecentSort(qb, query.cursor, limit);
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const dtos = await this.buildPostDtosBatch(
      items.map((p) => p.id),
      viewer,
    );

    const last = items[items.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      if (sort === 'popular') {
        const score = await this.computePopularScore(last.id);
        nextCursor = encodeCursor<PopularCursor>({ score, id: last.id });
      } else {
        nextCursor = encodeCursor<RecentCursor>({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        });
      }
    }
    return { items: dtos, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  async setReaction(
    postId: string,
    userId: string,
    type: ReactionType,
  ): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertVisible(post, userId);

    await this.reactions
      .createQueryBuilder()
      .insert()
      .into(Reaction)
      .values({ postId, userId, type })
      .orUpdate(['type'], ['post_id', 'user_id'])
      .execute();
  }

  async clearReaction(postId: string, userId: string): Promise<void> {
    await this.reactions.delete({ postId, userId });
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  async createComment(
    postId: string,
    authorId: string,
    dto: CreateCommentDto,
  ): Promise<CommentDto> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    await this.assertVisible(post, authorId);

    if (dto.parentId) {
      const parent = await this.comments.findOne({ where: { id: dto.parentId } });
      if (!parent || parent.postId !== postId || parent.deletedAt) {
        throw new NotFoundException('Parent comment not found');
      }
    }

    const row = this.comments.create({
      postId,
      parentId: dto.parentId ?? null,
      authorId,
      body: dto.body.trim(),
    });
    const saved = await this.comments.save(row);
    return this.buildCommentDto(saved);
  }

  async updateComment(
    commentId: string,
    actorId: string,
    dto: UpdateCommentDto,
  ): Promise<CommentDto> {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');
    if (comment.authorId !== actorId) {
      throw new ForbiddenException('Only the author can edit a comment');
    }
    comment.body = dto.body.trim();
    comment.editedAt = new Date();
    await this.comments.save(comment);
    return this.buildCommentDto(comment);
  }

  async deleteComment(commentId: string, actorId: string): Promise<void> {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');

    const post = await this.posts.findOne({
      where: { id: comment.postId },
      select: ['id', 'authorId', 'audience', 'groupId'],
    });
    if (!post) throw new NotFoundException('Comment not found');

    const canDelete =
      comment.authorId === actorId ||
      post.authorId === actorId ||
      (post.audience === 'group' &&
        post.groupId != null &&
        (await this.isGroupAdminOrOwner(post.groupId, actorId)));
    if (!canDelete) throw new ForbiddenException('Cannot delete this comment');

    comment.deletedAt = new Date();
    comment.body = null;
    await this.comments.save(comment);
  }

  async listTopLevelComments(
    postId: string,
    viewer: Viewer,
    query: ListCommentsDto,
  ): Promise<{ items: CommentDto[]; nextCursor: string | null }> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    await this.assertVisible(post, viewer);

    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor<RecentCursor>(query.cursor) : null;

    const qb = this.comments
      .createQueryBuilder('c')
      .where('c.post_id = :postId', { postId })
      .andWhere('c.parent_id IS NULL')
      .andWhere('c.deleted_at IS NULL')
      .orderBy('c.created_at', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere('(c.created_at, c.id) > (:cAt, :cId)', {
        cAt: cursor.createdAt,
        cId: cursor.id,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const dtos = await Promise.all(items.map((c) => this.buildCommentDto(c)));
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor<RecentCursor>({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null;
    return { items: dtos, nextCursor };
  }

  async listReplies(
    commentId: string,
    viewer: Viewer,
    query: ListCommentsDto,
  ): Promise<{ items: CommentDto[]; nextCursor: string | null }> {
    const parent = await this.comments.findOne({ where: { id: commentId } });
    if (!parent) throw new NotFoundException('Comment not found');
    const post = await this.posts.findOne({ where: { id: parent.postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.assertVisible(post, viewer);

    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor<RecentCursor>(query.cursor) : null;

    const qb = this.comments
      .createQueryBuilder('c')
      .where('c.parent_id = :parentId', { parentId: commentId })
      .andWhere('c.deleted_at IS NULL')
      .orderBy('c.created_at', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere('(c.created_at, c.id) > (:cAt, :cId)', {
        cAt: cursor.createdAt,
        cId: cursor.id,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const dtos = await Promise.all(items.map((c) => this.buildCommentDto(c)));
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor<RecentCursor>({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null;
    return { items: dtos, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------------------

  async favorite(postId: string, userId: string): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    await this.assertVisible(post, userId);
    await this.favorites
      .createQueryBuilder()
      .insert()
      .into(PostFavorite)
      .values({ postId, userId })
      .orIgnore()
      .execute();
  }

  async unfavorite(postId: string, userId: string): Promise<void> {
    await this.favorites.delete({ postId, userId });
  }

  // ---------------------------------------------------------------------------
  // Visibility helpers
  // ---------------------------------------------------------------------------

  /**
   * Throws 404 if the viewer can't see this post. Accepts either a Viewer
   * (for read paths that flow from an OptionalAuth route) or a known userId
   * string (for authenticated write paths).
   */
  private async assertVisible(post: Post, viewer: Viewer | string): Promise<void> {
    const viewerId =
      typeof viewer === 'string' ? viewer : viewer.userId;

    if (viewerId && post.authorId === viewerId) return;
    if (post.deletedAt) throw new NotFoundException('Post not found');

    if (viewerId) {
      const blocked = await this.blocks.findOne({
        where: [
          { blockerId: post.authorId, blockedId: viewerId },
          { blockerId: viewerId, blockedId: post.authorId },
        ],
        select: ['blockerId'],
      });
      if (blocked) throw new NotFoundException('Post not found');
    }

    if (post.audience === 'public') return;
    if (post.audience === 'private') throw new NotFoundException('Post not found');

    // Guests can only see audience='public' beyond this point.
    if (!viewerId) throw new NotFoundException('Post not found');

    if (post.audience === 'group') {
      if (!post.groupId) throw new NotFoundException('Post not found');
      const ok = await this.isGroupMember(post.groupId, viewerId);
      if (!ok) throw new NotFoundException('Post not found');
      return;
    }

    if (post.audience === 'friends') {
      const ok = await this.areFriends(post.authorId, viewerId);
      if (!ok) throw new NotFoundException('Post not found');
      return;
    }
  }

  private async areFriends(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const [low, high] = a < b ? [a, b] : [b, a];
    const row = await this.friendships.findOne({
      where: { userLow: low, userHigh: high, status: FriendshipStatus.ACCEPTED },
      select: ['userLow'],
    });
    return !!row;
  }

  private async isGroupMember(groupId: string, userId: string): Promise<boolean> {
    const row = await this.members.findOne({
      where: { groupId, userId, status: GroupMemberStatus.ACTIVE },
      select: ['userId'],
    });
    return !!row;
  }

  private async isGroupAdminOrOwner(groupId: string, userId: string): Promise<boolean> {
    const row = await this.members.findOne({
      where: { groupId, userId, status: GroupMemberStatus.ACTIVE },
    });
    return !!row && (row.role === 'admin' || row.role === 'owner');
  }

  private async assertGroupMember(groupId: string, userId: string): Promise<void> {
    const ok = await this.isGroupMember(groupId, userId);
    if (!ok) throw new ForbiddenException('Not a member of this group');
  }

  private assertAudienceGroupConsistency(
    audience: PostAudience,
    groupId?: string,
  ): void {
    if (audience === 'group' && !groupId) {
      throw new BadRequestException('groupId is required for group posts');
    }
    if (audience !== 'group' && groupId) {
      throw new BadRequestException('groupId is only allowed for group posts');
    }
  }

  private async requireOwnPost(postId: string, actorId: string): Promise<Post> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== actorId) {
      throw new ForbiddenException('Only the author can edit this post');
    }
    return post;
  }

  // ---------------------------------------------------------------------------
  // Mention extraction
  // ---------------------------------------------------------------------------

  private async resolveMentions(body: string, authorId: string): Promise<string[]> {
    const usernames = new Set<string>();
    for (const match of body.matchAll(MENTION_REGEX)) {
      usernames.add(match[1]);
    }
    if (usernames.size === 0) return [];

    const found = await this.users.find({
      where: { username: In([...usernames]) },
      select: ['id'],
    });
    return found.map((u) => u.id).filter((id) => id !== authorId);
  }

  // ---------------------------------------------------------------------------
  // Query: lens + visibility
  // ---------------------------------------------------------------------------

  private applyLens(
    qb: ReturnType<Repository<Post>['createQueryBuilder']>,
    lens: ActivityLens,
    targetUserId: string,
    viewerId: string | null,
  ): void {
    switch (lens) {
      case 'personal':
        qb.andWhere('p.author_id = :targetUserId', { targetUserId });
        break;
      case 'mentions':
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM post_mentions pm
             WHERE pm.post_id = p.id AND pm.user_id = :targetUserId
          )`,
          { targetUserId },
        );
        break;
      case 'favorites':
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM post_favorites pf
             WHERE pf.post_id = p.id AND pf.user_id = :targetUserId
          )`,
          { targetUserId },
        );
        break;
      case 'friends':
        // Guests are rejected upstream; viewerId is non-null here.
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM friendships f
             WHERE f.status = 'accepted'
               AND ((f.user_low  = :viewerId AND f.user_high = p.author_id)
                 OR (f.user_high = :viewerId AND f.user_low  = p.author_id))
          )`,
          { viewerId },
        );
        break;
      case 'groups':
        qb.andWhere(
          `p.audience = 'group'
           AND EXISTS (
             SELECT 1 FROM group_members gm
              WHERE gm.group_id = p.group_id
                AND gm.user_id  = :viewerId
                AND gm.status   = 'active'
           )`,
          { viewerId },
        );
        break;
    }
  }

  private applyVisibility<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    viewerId: string | null,
  ): void {
    if (viewerId === null) {
      // Guests see public posts only. No block check (we don't know who they are).
      qb.andWhere(`p.audience = 'public'`);
      return;
    }

    qb.andWhere(
      `(
        p.author_id = :viewerId
        OR p.audience = 'public'
        OR (p.audience = 'group' AND EXISTS (
              SELECT 1 FROM group_members gm
               WHERE gm.group_id = p.group_id
                 AND gm.user_id  = :viewerId
                 AND gm.status   = 'active'
            ))
        OR (p.audience = 'friends' AND EXISTS (
              SELECT 1 FROM friendships f
               WHERE f.status = 'accepted'
                 AND ((f.user_low = :viewerId AND f.user_high = p.author_id)
                   OR (f.user_high = :viewerId AND f.user_low = p.author_id))
            ))
      )`,
      { viewerId },
    );

    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = p.author_id AND b.blocked_id = :viewerId)
            OR (b.blocker_id = :viewerId   AND b.blocked_id = p.author_id)
      )`,
      { viewerId },
    );
  }

  private applyRecentSort(
    qb: ReturnType<Repository<Post>['createQueryBuilder']>,
    cursor: string | undefined,
    limit: number,
  ): void {
    if (cursor) {
      const decoded = decodeCursor<RecentCursor>(cursor);
      qb.andWhere('(p.created_at, p.id) < (:cAt, :cId)', {
        cAt: decoded.createdAt,
        cId: decoded.id,
      });
    }
    qb.orderBy('p.created_at', 'DESC').addOrderBy('p.id', 'DESC').take(limit + 1);
  }

  private applyPopularSort(
    qb: ReturnType<Repository<Post>['createQueryBuilder']>,
    cursor: string | undefined,
    limit: number,
  ): void {
    // score = (reaction_count + 2*comment_count) within POPULAR_WINDOW
    const windowStart = new Date(Date.now() - POPULAR_WINDOW_MS).toISOString();
    qb.addSelect(
      `(
        (SELECT count(*)::int FROM reactions r WHERE r.post_id = p.id)
        + 2 * (SELECT count(*)::int FROM comments c
                WHERE c.post_id = p.id AND c.deleted_at IS NULL)
      )`,
      'popularity_score',
    );
    qb.andWhere('p.created_at >= :windowStart', { windowStart });

    if (cursor) {
      const decoded = decodeCursor<PopularCursor>(cursor);
      qb.andWhere(
        `(
          (SELECT count(*)::int FROM reactions r WHERE r.post_id = p.id)
          + 2 * (SELECT count(*)::int FROM comments c
                  WHERE c.post_id = p.id AND c.deleted_at IS NULL),
          p.id
        ) < (:cScore, :cId)`,
        { cScore: decoded.score, cId: decoded.id },
      );
    }
    qb.orderBy('popularity_score', 'DESC').addOrderBy('p.id', 'DESC').take(limit + 1);
  }

  private async computePopularScore(postId: string): Promise<number> {
    const row: Array<{ score: string }> = await this.ds.query(
      `select (
        (select count(*) from public.reactions r where r.post_id = $1)
        + 2 * (select count(*) from public.comments c
                where c.post_id = $1 and c.deleted_at is null)
      )::text as score`,
      [postId],
    );
    return Number(row[0]?.score ?? 0);
  }

  // ---------------------------------------------------------------------------
  // DTO assembly
  // ---------------------------------------------------------------------------

  private async buildPostDto(postId: string, viewer: Viewer | string): Promise<PostDto> {
    const dtos = await this.buildPostDtosBatch([postId], viewer);
    if (!dtos[0]) throw new NotFoundException('Post not found');
    return dtos[0];
  }

  private async buildPostDtosBatch(
    postIds: string[],
    viewer: Viewer | string,
  ): Promise<PostDto[]> {
    if (postIds.length === 0) return [];
    const viewerId = typeof viewer === 'string' ? viewer : viewer.userId;
    const isGuest = viewerId === null;

    const posts = await this.posts.find({
      where: { id: In(postIds) },
    });
    const postById = new Map(posts.map((p) => [p.id, p]));

    const [attachments, mentions, reactions, viewerReactions, favorites, commentCounts] =
      await Promise.all([
        this.attachments.find({ where: { postId: In(postIds) } }),
        this.mentions.find({ where: { postId: In(postIds) } }),
        this.reactions.find({ where: { postId: In(postIds) } }),
        viewerId
          ? this.reactions.find({ where: { postId: In(postIds), userId: viewerId } })
          : Promise.resolve([] as Reaction[]),
        viewerId
          ? this.favorites.find({ where: { postId: In(postIds), userId: viewerId } })
          : Promise.resolve([] as PostFavorite[]),
        this.countCommentsByPost(postIds),
      ]);

    const authorIds = new Set<string>(posts.map((p) => p.authorId));
    for (const r of reactions) authorIds.add(r.userId);
    for (const m of mentions) authorIds.add(m.userId);
    const userMap = await this.loadAuthorMap([...authorIds]);

    const groupIds = posts.map((p) => p.groupId).filter((g): g is string => !!g);
    const groupMap = await this.loadGroupMap(groupIds);

    const attByPost = groupBy(attachments, (a) => a.postId);
    const menByPost = groupBy(mentions, (m) => m.postId);
    const reactByPost = groupBy(reactions, (r) => r.postId);
    const viewerReactByPost = new Map(viewerReactions.map((r) => [r.postId, r.type]));
    const favSet = new Set(favorites.map((f) => f.postId));

    return postIds
      .map((id) => postById.get(id))
      .filter((p): p is Post => !!p)
      .map((post) => {
        const author = userMap.get(post.authorId);
        return {
          id: post.id,
          author: author ?? unknownAuthor(post.authorId),
          audience: post.audience,
          group:
            post.groupId && groupMap.has(post.groupId)
              ? groupMap.get(post.groupId)!
              : null,
          body: post.body,
          attachments: (attByPost.get(post.id) ?? [])
            .slice()
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map(
              (a): PostAttachmentDto => ({
                id: a.id,
                kind: a.kind,
                url: a.url,
                thumbnailUrl: a.thumbnailUrl,
                width: a.width,
                height: a.height,
                displayOrder: a.displayOrder,
              }),
            ),
          mentions: (menByPost.get(post.id) ?? []).map((m) => {
            const u = userMap.get(m.userId);
            return {
              userId: m.userId,
              username: u?.username ?? '',
            };
          }),
          reactionSummary: this.summarizeReactions(
            reactByPost.get(post.id) ?? [],
            userMap,
            viewerReactByPost.get(post.id) ?? null,
            isGuest,
          ),
          commentCount: commentCounts.get(post.id) ?? 0,
          viewerFavorited: !isGuest && favSet.has(post.id),
          isDeleted: post.deletedAt !== null,
          editedAt: post.editedAt ? post.editedAt.toISOString() : null,
          createdAt: post.createdAt.toISOString(),
        };
      });
  }

  private summarizeReactions(
    rows: Reaction[],
    userMap: Map<string, PostAuthorDto>,
    viewerReaction: ReactionType | null,
    hideTopActors: boolean,
  ): ReactionSummaryDto {
    const byType: Partial<Record<ReactionType, number>> = {};
    for (const r of rows) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
    }
    const topActors: PostAuthorDto[] = [];
    if (!hideTopActors) {
      const sorted = rows
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      for (const r of sorted) {
        if (topActors.length >= 2) break;
        const u = userMap.get(r.userId);
        if (u) topActors.push(u);
      }
    }
    return {
      total: rows.length,
      byType,
      topActors,
      viewerReaction: hideTopActors ? null : viewerReaction,
    };
  }

  private async countCommentsByPost(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const rows: Array<{ post_id: string; count: string }> = await this.ds.query(
      `select post_id, count(*)::text as count
         from public.comments
        where post_id = any($1::uuid[]) and deleted_at is null
        group by post_id`,
      [postIds],
    );
    return new Map(rows.map((r) => [r.post_id, Number(r.count)]));
  }

  private async loadAuthorMap(userIds: string[]): Promise<Map<string, PostAuthorDto>> {
    if (userIds.length === 0) return new Map();
    const rows: Array<{
      id: string;
      username: string;
      display_name: string | null;
      avatar_url: string | null;
    }> = await this.ds.query(
      `select u.id, u.username::text as username,
              p.display_name, p.avatar_url
         from public.users u
         left join public.profiles p on p.user_id = u.id
        where u.id = any($1::uuid[])`,
      [userIds],
    );
    const map = new Map<string, PostAuthorDto>();
    for (const r of rows) {
      map.set(r.id, {
        userId: r.id,
        username: r.username,
        displayName: r.display_name ?? r.username,
        avatarUrl: r.avatar_url,
      });
    }
    return map;
  }

  private async loadGroupMap(
    groupIds: string[],
  ): Promise<Map<string, { id: string; slug: string; name: string }>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.groups.find({
      where: { id: In(groupIds), deletedAt: IsNull() },
      select: ['id', 'slug', 'name'],
    });
    return new Map(
      rows.map((g) => [g.id, { id: g.id, slug: g.slug, name: g.name }]),
    );
  }

  private async buildCommentDto(comment: Comment): Promise<CommentDto> {
    const author = (await this.loadAuthorMap([comment.authorId])).get(comment.authorId);
    const replyCount = comment.deletedAt
      ? 0
      : await this.comments.count({
          where: { parentId: comment.id, deletedAt: IsNull() },
        });
    return {
      id: comment.id,
      postId: comment.postId,
      parentId: comment.parentId,
      author: author ?? unknownAuthor(comment.authorId),
      body: comment.body,
      replyCount,
      isDeleted: comment.deletedAt !== null,
      editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
      createdAt: comment.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Retention (called by RetentionCron)
  // ---------------------------------------------------------------------------

  async purgeExpiredSoftDeleted(graceDays: number): Promise<{ posts: number; comments: number }> {
    const cutoff = new Date(Date.now() - graceDays * 86_400_000);
    const expiredPosts = await this.posts.find({
      where: { deletedAt: Not(IsNull()) },
      select: ['id', 'deletedAt'],
    });
    const expiredPostIds = expiredPosts
      .filter((p) => p.deletedAt && p.deletedAt < cutoff)
      .map((p) => p.id);
    let postsDeleted = 0;
    if (expiredPostIds.length > 0) {
      const res = await this.posts.delete({ id: In(expiredPostIds) });
      postsDeleted = res.affected ?? 0;
    }
    const expiredComments = await this.comments.find({
      where: { deletedAt: Not(IsNull()) },
      select: ['id', 'deletedAt'],
    });
    const expiredCommentIds = expiredComments
      .filter((c) => c.deletedAt && c.deletedAt < cutoff)
      .map((c) => c.id);
    let commentsDeleted = 0;
    if (expiredCommentIds.length > 0) {
      const res = await this.comments.delete({ id: In(expiredCommentIds) });
      commentsDeleted = res.affected ?? 0;
    }
    return { posts: postsDeleted, comments: commentsDeleted };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeCursor<T>(value: T): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string): T {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function groupBy<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function unknownAuthor(userId: string): PostAuthorDto {
  return {
    userId,
    username: '',
    displayName: '',
    avatarUrl: null,
  };
}
