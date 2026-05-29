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
  LessThan,
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
import { UserRole } from '../users/entities/user.entity';
import {
  BlogBlock,
  deriveExcerpt,
  imageUrlsIn,
  validateAndNormalizeBody,
} from './blog-blocks';
import { normalizeVideoUrl, slugify } from './blog-slug';
import {
  CreateBlogCommentDto,
  ListBlogCommentsDto,
  UpdateBlogCommentDto,
} from './dto/blog-comment.dto';
import { CreateBlogTagDto, UpdateBlogTagDto } from './dto/blog-tag.dto';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { ListBlogPostsDto } from './dto/list-blog-posts.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { BlogComment } from './entities/blog-comment.entity';
import { BlogPostLike } from './entities/blog-post-like.entity';
import { BlogPostTag } from './entities/blog-post-tag.entity';
import { BlogPost, BlogPostStatus } from './entities/blog-post.entity';
import { BlogTag } from './entities/blog-tag.entity';

const POPULAR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ----- DTO shapes (wire format) -----

export interface BlogAuthorDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface BlogTagDto {
  slug: string;
  name: string;
}

export interface BlogCoverDto {
  imageUrl: string | null;
  videoUrl: string | null;
}

export interface BlogPostDto {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: BlogBlock[];
  author: BlogAuthorDto;
  cover: BlogCoverDto;
  tags: BlogTagDto[];
  status: BlogPostStatus;
  likeCount: number;
  commentCount: number;
  viewerLiked: boolean;
  publishedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogListResponse {
  items: BlogPostDto[];
  total: number;
  page: number;
  limit: number;
}

export interface BlogCommentDto {
  id: string;
  postId: string;
  parentId: string | null;
  author: BlogAuthorDto;
  body: string | null;
  replyCount: number;
  isDeleted: boolean;
  editedAt: string | null;
  createdAt: string;
}

export interface BlogLikeResponse {
  likeCount: number;
  viewerLiked: boolean;
}

interface CommentCursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class BlogService {
  constructor(
    @InjectRepository(BlogPost) private readonly posts: Repository<BlogPost>,
    @InjectRepository(BlogPostTag)
    private readonly postTags: Repository<BlogPostTag>,
    @InjectRepository(BlogTag) private readonly tags: Repository<BlogTag>,
    @InjectRepository(BlogPostLike)
    private readonly likes: Repository<BlogPostLike>,
    @InjectRepository(BlogComment)
    private readonly comments: Repository<BlogComment>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------------------------------------------------------------------------
  // Posts CRUD
  // ---------------------------------------------------------------------------

  async list(
    viewer: Viewer,
    query: ListBlogPostsDto,
  ): Promise<BlogListResponse> {
    const page = query.page;
    const limit = query.limit;
    const sort = query.sort;

    const qb = this.posts.createQueryBuilder('p').where('p.deleted_at IS NULL');

    // status filter — editors may request drafts/archived, everyone else
    // is clamped to published.
    if (!viewer.isStaff) {
      qb.andWhere(`p.status = 'published'`);
    } else if (query.status) {
      qb.andWhere('p.status = :status', { status: query.status });
    } else {
      qb.andWhere(`p.status = 'published'`);
    }

    if (query.q) {
      qb.andWhere(
        '(p.title ILIKE :q OR p.excerpt ILIKE :q)',
        { q: `%${query.q}%` },
      );
    }
    if (query.authorId) {
      qb.andWhere('p.author_id = :authorId', { authorId: query.authorId });
    }
    if (query.tag) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM blog_post_tags bt
           WHERE bt.post_id = p.id AND bt.tag_slug = :tag
        )`,
        { tag: query.tag },
      );
    }

    if (sort === 'popular') {
      this.applyPopularSort(qb);
    } else {
      qb.orderBy('p.published_at', 'DESC', 'NULLS LAST').addOrderBy(
        'p.created_at',
        'DESC',
      );
    }

    const total = await qb.getCount();
    qb.skip((page - 1) * limit).take(limit);
    const rows = await qb.getMany();
    const items = await this.buildPostDtosBatch(
      rows.map((r) => r.id),
      viewer,
    );
    return { items, total, page, limit };
  }

  async findBySlug(slug: string, viewer: Viewer): Promise<BlogPostDto> {
    const post = await this.posts.findOne({ where: { slug } });
    if (!post) throw new NotFoundException('Post not found');
    this.assertVisible(post, viewer);
    return this.buildPostDto(post.id, viewer);
  }

  /**
   * Single-shot multipart create. Everything in one request:
   *   - `coverFile`  — cover image (or none / a `coverVideoUrl` instead)
   *   - `mediaFiles` — body images, referenced from the body by `{ ref: N }`
   *   - `dto.body`   — JSON-parsed list of blocks
   *
   * Uploads happen first (outside the DB transaction). On any failure
   * (validation, DB write), the uploaded blobs are best-effort deleted to
   * avoid orphaning storage.
   */
  async create(
    authorId: string,
    actorRole: UserRole,
    dto: CreateBlogPostDto,
    coverFile?: UploadedFile,
    mediaFiles: UploadedFile[] = [],
  ): Promise<BlogPostDto> {
    this.assertEditorRole(actorRole);

    if (coverFile && dto.coverVideoUrl) {
      throw new BadRequestException(
        'Cover must be either an image (file) or a video URL, not both',
      );
    }

    const bucket = this.config.get('supabase.blogMediaBucket', { infer: true });
    const uploaded: StoredFile[] = [];

    try {
      // Upload everything first — outside the DB transaction so partial
      // failures don't leave a half-open txn.
      let coverImageUrl: string | null = null;
      if (coverFile) {
        const stored = await this.storage.uploadOne(
          bucket,
          authorId,
          coverFile,
          { pathPrefix: 'blog/cover', allow: ['photo'] },
        );
        uploaded.push(stored);
        coverImageUrl = stored.url;
      }

      let bodyImageUrls: string[] = [];
      if (mediaFiles.length > 0) {
        const stored = await this.storage.uploadMany(
          bucket,
          authorId,
          mediaFiles,
          { pathPrefix: 'blog/body', allow: ['photo'] },
        );
        uploaded.push(...stored);
        bodyImageUrls = stored.map((s) => s.url);
      }

      // Resolve `{ ref: N }` against bodyImageUrls and validate everything.
      const body = validateAndNormalizeBody(dto.body, bodyImageUrls, (url) =>
        this.isOwnBucketUrl(url),
      );

      // Cover-video URL is normalized (YouTube/Vimeo whitelist).
      let coverVideoUrl: string | null = null;
      if (dto.coverVideoUrl) {
        const normalized = normalizeVideoUrl(dto.coverVideoUrl);
        if (!normalized) {
          throw new BadRequestException(
            'coverVideoUrl must be a YouTube or Vimeo URL',
          );
        }
        coverVideoUrl = normalized;
      }

      const status: BlogPostStatus = dto.status ?? 'draft';
      if (status === 'published' && !coverImageUrl && !coverVideoUrl) {
        throw new BadRequestException('Cover image or video required to publish');
      }

      const excerpt = (dto.excerpt?.trim() || deriveExcerpt(body)).slice(0, 500);
      if (excerpt.length === 0) {
        throw new BadRequestException(
          'Excerpt is empty (provide one or include a paragraph block)',
        );
      }

      const slug = await this.deriveUniqueSlug(dto.title);

      const savedId = await this.ds.transaction(async (m) => {
        const post = m.getRepository(BlogPost).create({
          slug,
          authorId,
          title: dto.title.trim(),
          excerpt,
          body,
          coverImageUrl,
          coverVideoUrl,
          status,
          publishedAt: status === 'published' ? new Date() : null,
        });
        const saved = await m.getRepository(BlogPost).save(post);

        if (dto.tagSlugs && dto.tagSlugs.length > 0) {
          await this.ensureTagsExist(m.getRepository(BlogTag), dto.tagSlugs);
          await m
            .getRepository(BlogPostTag)
            .save(dto.tagSlugs.map((t) => ({ postId: saved.id, tagSlug: t })));
        }
        return saved.id;
      });

      await this.audit.record({
        actorId: authorId,
        action: 'blog_post.create',
        metadata: { postId: savedId, status },
      });

      return this.buildPostDto(savedId, authorId);
    } catch (err) {
      for (const u of uploaded) {
        await this.storage.delete(bucket, u.path).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Single-shot multipart patch. Same upload-first / clean-up-on-failure
   * pattern as `create`. Body is authoritative — pass the FULL new array
   * when changing it; image URLs that disappear from the new body are
   * best-effort deleted from storage post-commit.
   */
  async patch(
    postId: string,
    actorId: string,
    actorRole: UserRole,
    dto: UpdateBlogPostDto,
    coverFile?: UploadedFile,
    mediaFiles: UploadedFile[] = [],
  ): Promise<BlogPostDto> {
    this.assertEditorRole(actorRole);
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');

    if (coverFile && dto.coverVideoUrl) {
      throw new BadRequestException(
        'Cover must be either an image (file) or a video URL, not both',
      );
    }
    if ((coverFile || dto.coverVideoUrl) && dto.clearCover) {
      throw new BadRequestException(
        'clearCover cannot be combined with a new cover',
      );
    }

    const bucket = this.config.get('supabase.blogMediaBucket', { infer: true });
    const uploaded: StoredFile[] = [];
    const prevCoverImageUrl = post.coverImageUrl;
    const prevBodyImageUrls = post.body ? imageUrlsIn(post.body) : [];

    try {
      // Upload first (outside txn).
      if (coverFile) {
        const stored = await this.storage.uploadOne(
          bucket,
          actorId,
          coverFile,
          { pathPrefix: 'blog/cover', allow: ['photo'] },
        );
        uploaded.push(stored);
        post.coverImageUrl = stored.url;
        post.coverVideoUrl = null;
      }

      let bodyImageUrls: string[] = [];
      if (mediaFiles.length > 0) {
        const stored = await this.storage.uploadMany(
          bucket,
          actorId,
          mediaFiles,
          { pathPrefix: 'blog/body', allow: ['photo'] },
        );
        uploaded.push(...stored);
        bodyImageUrls = stored.map((s) => s.url);
      }

      let bodyChanged = false;
      if (dto.body !== undefined) {
        const nextBody = validateAndNormalizeBody(
          dto.body,
          bodyImageUrls,
          (url) => this.isOwnBucketUrl(url),
        );
        post.body = nextBody;
        bodyChanged = true;
        post.editedAt = new Date();
        if (dto.excerpt === undefined) {
          post.excerpt = deriveExcerpt(nextBody).slice(0, 500) || post.excerpt;
        }
      } else if (mediaFiles.length > 0) {
        // The editor uploaded body images but didn't pass a new body to
        // reference them — that's a misuse, fail loudly so the uploaded
        // blobs get cleaned up.
        throw new BadRequestException(
          'media files were uploaded but no body was provided to reference them',
        );
      }

      if (dto.title !== undefined) post.title = dto.title.trim();
      if (dto.excerpt !== undefined) {
        const trimmed = dto.excerpt.trim();
        if (trimmed.length === 0) {
          throw new BadRequestException('Excerpt cannot be empty');
        }
        post.excerpt = trimmed.slice(0, 500);
      }

      if (dto.coverVideoUrl !== undefined) {
        if (dto.coverVideoUrl === '') {
          post.coverVideoUrl = null;
        } else {
          const normalized = normalizeVideoUrl(dto.coverVideoUrl);
          if (!normalized) {
            throw new BadRequestException(
              'coverVideoUrl must be a YouTube or Vimeo URL',
            );
          }
          post.coverVideoUrl = normalized;
          post.coverImageUrl = null;
        }
      }
      if (dto.clearCover) {
        post.coverImageUrl = null;
        post.coverVideoUrl = null;
      }

      // Status transition + publish requirements.
      if (dto.status && dto.status !== post.status) {
        if (dto.status === 'published') {
          if (!post.coverImageUrl && !post.coverVideoUrl) {
            throw new BadRequestException(
              'Cover image or video required to publish',
            );
          }
          if (!post.publishedAt) post.publishedAt = new Date();
        }
        post.status = dto.status;
      }

      await this.ds.transaction(async (m) => {
        await m.getRepository(BlogPost).save(post);

        if (dto.tagSlugs) {
          await m.getRepository(BlogPostTag).delete({ postId });
          if (dto.tagSlugs.length > 0) {
            await this.ensureTagsExist(m.getRepository(BlogTag), dto.tagSlugs);
            await m
              .getRepository(BlogPostTag)
              .save(dto.tagSlugs.map((t) => ({ postId, tagSlug: t })));
          }
        }
      });

      // Post-commit storage cleanup. Best-effort; failures are logged inside
      // StorageService and don't roll back the DB write.
      if (
        coverFile &&
        prevCoverImageUrl &&
        prevCoverImageUrl !== post.coverImageUrl
      ) {
        await this.deleteByPublicUrl(bucket, prevCoverImageUrl);
      }
      if (dto.clearCover && prevCoverImageUrl) {
        await this.deleteByPublicUrl(bucket, prevCoverImageUrl);
      }
      if (dto.coverVideoUrl && prevCoverImageUrl) {
        // Switched from image-cover to video-cover.
        await this.deleteByPublicUrl(bucket, prevCoverImageUrl);
      }
      if (bodyChanged && post.body) {
        const nextSet = new Set(imageUrlsIn(post.body));
        for (const url of prevBodyImageUrls) {
          if (!nextSet.has(url)) {
            await this.deleteByPublicUrl(bucket, url);
          }
        }
      }

      await this.audit.record({
        actorId,
        action: 'blog_post.patch',
        metadata: { postId, status: post.status },
      });

      return this.buildPostDto(postId, actorId);
    } catch (err) {
      for (const u of uploaded) {
        await this.storage.delete(bucket, u.path).catch(() => undefined);
      }
      throw err;
    }
  }

  async softDelete(
    postId: string,
    actorId: string,
    actorRole: UserRole,
  ): Promise<void> {
    this.assertEditorRole(actorRole);
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');

    post.deletedAt = new Date();
    post.body = null;
    await this.posts.save(post);

    await this.audit.record({
      actorId,
      targetId: post.authorId,
      action: 'blog_post.soft_delete',
      metadata: { postId },
    });
  }

  // ---------------------------------------------------------------------------
  // Likes
  // ---------------------------------------------------------------------------

  async like(postId: string, userId: string): Promise<BlogLikeResponse> {
    const post = await this.posts.findOne({
      where: { id: postId },
      select: ['id', 'status', 'deletedAt'],
    });
    if (!post || post.deletedAt || post.status !== 'published') {
      throw new NotFoundException('Post not found');
    }
    await this.likes
      .createQueryBuilder()
      .insert()
      .into(BlogPostLike)
      .values({ postId, userId })
      .orIgnore()
      .execute();
    return this.likeSummary(postId, userId);
  }

  async unlike(postId: string, userId: string): Promise<BlogLikeResponse> {
    const post = await this.posts.findOne({
      where: { id: postId },
      select: ['id', 'status', 'deletedAt'],
    });
    if (!post || post.deletedAt || post.status !== 'published') {
      throw new NotFoundException('Post not found');
    }
    await this.likes.delete({ postId, userId });
    return this.likeSummary(postId, userId);
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  async createComment(
    postId: string,
    authorId: string,
    dto: CreateBlogCommentDto,
  ): Promise<BlogCommentDto> {
    const post = await this.posts.findOne({
      where: { id: postId },
      select: ['id', 'status', 'deletedAt'],
    });
    if (!post || post.deletedAt || post.status !== 'published') {
      throw new NotFoundException('Post not found');
    }
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
    dto: UpdateBlogCommentDto,
  ): Promise<BlogCommentDto> {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment || comment.deletedAt) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.authorId !== actorId) {
      throw new ForbiddenException('Only the author can edit a comment');
    }
    comment.body = dto.body.trim();
    comment.editedAt = new Date();
    await this.comments.save(comment);
    return this.buildCommentDto(comment);
  }

  async deleteComment(
    commentId: string,
    actorId: string,
    actorRole: UserRole,
  ): Promise<void> {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment || comment.deletedAt) {
      throw new NotFoundException('Comment not found');
    }
    const isAuthor = comment.authorId === actorId;
    const isEditor =
      actorRole === UserRole.MODERATOR || actorRole === UserRole.ADMIN;
    if (!isAuthor && !isEditor) {
      throw new ForbiddenException('Cannot delete this comment');
    }
    comment.deletedAt = new Date();
    comment.body = null;
    await this.comments.save(comment);
  }

  async listTopLevelComments(
    postId: string,
    query: ListBlogCommentsDto,
  ): Promise<{ items: BlogCommentDto[]; nextCursor: string | null }> {
    const post = await this.posts.findOne({
      where: { id: postId },
      select: ['id', 'status', 'deletedAt'],
    });
    if (!post || post.deletedAt || post.status !== 'published') {
      throw new NotFoundException('Post not found');
    }
    return this.pageComments(
      this.comments
        .createQueryBuilder('c')
        .where('c.post_id = :postId', { postId })
        .andWhere('c.parent_id IS NULL')
        .andWhere('c.deleted_at IS NULL'),
      query,
    );
  }

  async listReplies(
    commentId: string,
    query: ListBlogCommentsDto,
  ): Promise<{ items: BlogCommentDto[]; nextCursor: string | null }> {
    const parent = await this.comments.findOne({ where: { id: commentId } });
    if (!parent) throw new NotFoundException('Comment not found');
    return this.pageComments(
      this.comments
        .createQueryBuilder('c')
        .where('c.parent_id = :parentId', { parentId: commentId })
        .andWhere('c.deleted_at IS NULL'),
      query,
    );
  }

  private async pageComments(
    qb: SelectQueryBuilder<BlogComment>,
    query: ListBlogCommentsDto,
  ): Promise<{ items: BlogCommentDto[]; nextCursor: string | null }> {
    const limit = query.limit;
    const cursor = query.cursor ? decodeCursor<CommentCursor>(query.cursor) : null;
    qb.orderBy('c.created_at', 'ASC').addOrderBy('c.id', 'ASC').take(limit + 1);
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
        ? encodeCursor<CommentCursor>({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null;
    return { items: dtos, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  async listTags(): Promise<BlogTagDto[]> {
    const rows = await this.tags.find({ order: { name: 'ASC' } });
    return rows.map((t) => ({ slug: t.slug, name: t.name }));
  }

  async createTag(
    actorId: string,
    actorRole: UserRole,
    dto: CreateBlogTagDto,
  ): Promise<BlogTagDto> {
    this.assertEditorRole(actorRole);
    const existing = await this.tags.findOne({ where: { slug: dto.slug } });
    if (existing) throw new BadRequestException('Tag already exists');
    const row = await this.tags.save(this.tags.create({ slug: dto.slug, name: dto.name }));
    await this.audit.record({
      actorId,
      action: 'blog_tag.create',
      metadata: { slug: dto.slug },
    });
    return { slug: row.slug, name: row.name };
  }

  async updateTag(
    actorId: string,
    actorRole: UserRole,
    slug: string,
    dto: UpdateBlogTagDto,
  ): Promise<BlogTagDto> {
    this.assertEditorRole(actorRole);
    const row = await this.tags.findOne({ where: { slug } });
    if (!row) throw new NotFoundException('Tag not found');
    row.name = dto.name;
    await this.tags.save(row);
    await this.audit.record({
      actorId,
      action: 'blog_tag.update',
      metadata: { slug },
    });
    return { slug: row.slug, name: row.name };
  }

  async deleteTag(
    actorId: string,
    actorRole: UserRole,
    slug: string,
  ): Promise<void> {
    this.assertEditorRole(actorRole);
    const row = await this.tags.findOne({ where: { slug } });
    if (!row) throw new NotFoundException('Tag not found');
    await this.tags.delete({ slug });
    await this.audit.record({
      actorId,
      action: 'blog_tag.delete',
      metadata: { slug },
    });
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  async purgeExpiredSoftDeleted(
    graceDays: number,
  ): Promise<{ posts: number; comments: number }> {
    const cutoff = new Date(Date.now() - graceDays * 86_400_000);
    const expiredPosts = await this.posts.find({
      where: { deletedAt: LessThan(cutoff) },
      select: ['id'],
    });
    let postsDeleted = 0;
    if (expiredPosts.length > 0) {
      const res = await this.posts.delete({
        id: In(expiredPosts.map((p) => p.id)),
      });
      postsDeleted = res.affected ?? 0;
    }
    const expiredComments = await this.comments.find({
      where: { deletedAt: LessThan(cutoff) },
      select: ['id'],
    });
    let commentsDeleted = 0;
    if (expiredComments.length > 0) {
      const res = await this.comments.delete({
        id: In(expiredComments.map((c) => c.id)),
      });
      commentsDeleted = res.affected ?? 0;
    }
    return { posts: postsDeleted, comments: commentsDeleted };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private assertEditorRole(role: UserRole): void {
    if (role !== UserRole.MODERATOR && role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only editors can perform this action');
    }
  }

  private assertVisible(post: BlogPost, viewer: Viewer): void {
    if (post.deletedAt) {
      if (viewer.isStaff || (viewer.userId && post.authorId === viewer.userId)) {
        return;
      }
      throw new NotFoundException('Post not found');
    }
    if (post.status === 'published') return;
    if (viewer.userId && post.authorId === viewer.userId) return;
    if (viewer.isStaff) return;
    throw new NotFoundException('Post not found');
  }

  /**
   * Image URLs in body blocks and the cover must come from our own bucket —
   * stops editors from hotlinking external assets (which may break) or
   * pasting tracking pixels.
   */
  private isOwnBucketUrl(url: string): boolean {
    const bucket = this.config.get('supabase.blogMediaBucket', { infer: true });
    return url.includes(`/storage/v1/object/public/${bucket}/`);
  }

  /**
   * Unknown slugs auto-create with a humanized name (`health-care` →
   * `Health Care`). Editors are the only ones that ever hit this path, and
   * tags are admin-curated anyway, so requiring a separate `POST /blog/tags`
   * round-trip for every new slug was friction without benefit. The
   * dedicated tags endpoints remain available when the editor wants to set
   * a non-derived display name (e.g. `ai-ml` → `AI/ML`).
   *
   * `orIgnore()` covers the concurrent-create race (two posts under the
   * same new slug at once).
   */
  private async ensureTagsExist(
    repo: Repository<BlogTag>,
    slugs: string[],
  ): Promise<void> {
    if (slugs.length === 0) return;
    const found = await repo.find({
      where: { slug: In(slugs) },
      select: ['slug'],
    });
    const existing = new Set(found.map((t) => t.slug));
    const missing = slugs.filter((s) => !existing.has(s));
    if (missing.length === 0) return;
    await repo
      .createQueryBuilder()
      .insert()
      .into(BlogTag)
      .values(missing.map((slug) => ({ slug, name: humanizeSlug(slug) })))
      .orIgnore()
      .execute();
  }

  private async deriveUniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    while (n < 100) {
      const existing = await this.posts.findOne({
        where: { slug: candidate },
        select: ['id'],
      });
      if (!existing) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
    }
    throw new BadRequestException('Could not derive a unique slug');
  }

  private async deleteByPublicUrl(bucket: string, url: string): Promise<void> {
    // Public URLs look like:
    //   {origin}/storage/v1/object/public/{bucket}/{path}
    // We only need the path portion after `/public/{bucket}/`.
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return;
    const path = url.slice(idx + marker.length);
    await this.storage.delete(bucket, path).catch(() => undefined);
  }

  private applyPopularSort(qb: SelectQueryBuilder<BlogPost>): void {
    // score = (likes + 2*comments) within a 30-day window. Editorial
    // volume is low enough that offset paging is stable across re-reads
    // — no cursor wobble like the activity feed.
    const windowStart = new Date(Date.now() - POPULAR_WINDOW_MS).toISOString();
    qb.addSelect(
      `(
        (SELECT count(*)::int FROM blog_post_likes l WHERE l.post_id = p.id)
        + 2 * (SELECT count(*)::int FROM blog_comments c
                WHERE c.post_id = p.id AND c.deleted_at IS NULL)
      )`,
      'popularity_score',
    )
      .andWhere(
        '(p.published_at IS NULL OR p.published_at >= :windowStart)',
        { windowStart },
      )
      .orderBy('popularity_score', 'DESC')
      .addOrderBy('p.published_at', 'DESC', 'NULLS LAST')
      .addOrderBy('p.id', 'DESC');
  }

  // ---------------------------------------------------------------------------
  // DTO assembly
  // ---------------------------------------------------------------------------

  private async buildPostDto(
    postId: string,
    viewer: Viewer | string,
  ): Promise<BlogPostDto> {
    const dtos = await this.buildPostDtosBatch([postId], viewer);
    if (!dtos[0]) throw new NotFoundException('Post not found');
    return dtos[0];
  }

  private async buildPostDtosBatch(
    postIds: string[],
    viewer: Viewer | string,
  ): Promise<BlogPostDto[]> {
    if (postIds.length === 0) return [];
    const viewerId =
      typeof viewer === 'string' ? viewer : viewer.userId;

    const posts = await this.posts.find({ where: { id: In(postIds) } });
    const postById = new Map(posts.map((p) => [p.id, p]));

    const [tagJoins, likeCounts, commentCounts, viewerLikes] = await Promise.all([
      this.postTags.find({ where: { postId: In(postIds) } }),
      this.countLikesByPost(postIds),
      this.countCommentsByPost(postIds),
      viewerId
        ? this.likes.find({
            where: { postId: In(postIds), userId: viewerId },
          })
        : Promise.resolve([] as BlogPostLike[]),
    ]);

    const tagSlugs = [...new Set(tagJoins.map((t) => t.tagSlug))];
    const tagRows = tagSlugs.length
      ? await this.tags.find({ where: { slug: In(tagSlugs) } })
      : [];
    const tagBySlug = new Map(tagRows.map((t) => [t.slug, t]));

    const authorIds = [...new Set(posts.map((p) => p.authorId))];
    const authorMap = await this.loadAuthorMap(authorIds);

    const tagsByPost = groupBy(tagJoins, (t) => t.postId);
    const viewerLikedSet = new Set(viewerLikes.map((l) => l.postId));

    return postIds
      .map((id) => postById.get(id))
      .filter((p): p is BlogPost => !!p)
      .map((post) => ({
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        body: post.body ?? [],
        author: authorMap.get(post.authorId) ?? unknownAuthor(post.authorId),
        cover: {
          imageUrl: post.coverImageUrl,
          videoUrl: post.coverVideoUrl,
        },
        tags: (tagsByPost.get(post.id) ?? [])
          .map((t) => tagBySlug.get(t.tagSlug))
          .filter((t): t is BlogTag => !!t)
          .map((t) => ({ slug: t.slug, name: t.name })),
        status: post.status,
        likeCount: likeCounts.get(post.id) ?? 0,
        commentCount: commentCounts.get(post.id) ?? 0,
        viewerLiked: viewerLikedSet.has(post.id),
        publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
        editedAt: post.editedAt ? post.editedAt.toISOString() : null,
        createdAt: post.createdAt.toISOString(),
        updatedAt: post.updatedAt.toISOString(),
      }));
  }

  private async buildCommentDto(comment: BlogComment): Promise<BlogCommentDto> {
    const author = (await this.loadAuthorMap([comment.authorId])).get(
      comment.authorId,
    );
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

  private async likeSummary(
    postId: string,
    userId: string,
  ): Promise<BlogLikeResponse> {
    const [count, viewer] = await Promise.all([
      this.likes.count({ where: { postId } }),
      this.likes.findOne({ where: { postId, userId }, select: ['postId'] }),
    ]);
    return { likeCount: count, viewerLiked: !!viewer };
  }

  private async countLikesByPost(
    postIds: string[],
  ): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const rows: Array<{ post_id: string; count: string }> = await this.ds.query(
      `select post_id, count(*)::text as count
         from public.blog_post_likes
        where post_id = any($1::uuid[])
        group by post_id`,
      [postIds],
    );
    return new Map(rows.map((r) => [r.post_id, Number(r.count)]));
  }

  private async countCommentsByPost(
    postIds: string[],
  ): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const rows: Array<{ post_id: string; count: string }> = await this.ds.query(
      `select post_id, count(*)::text as count
         from public.blog_comments
        where post_id = any($1::uuid[]) and deleted_at is null
        group by post_id`,
      [postIds],
    );
    return new Map(rows.map((r) => [r.post_id, Number(r.count)]));
  }

  private async loadAuthorMap(
    userIds: string[],
  ): Promise<Map<string, BlogAuthorDto>> {
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
    const map = new Map<string, BlogAuthorDto>();
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

function unknownAuthor(userId: string): BlogAuthorDto {
  return { userId, username: '', displayName: '', avatarUrl: null };
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export type { BlogBlock } from './blog-blocks';
