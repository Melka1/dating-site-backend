import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentViewer } from '../../common/decorators/current-viewer.decorator';
import type { UploadedFile } from '../../common/storage/storage.service';
import type { Viewer } from '../../common/viewer';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { RequireVerified } from '../auth/decorators/require-verified.decorator';
import { UserRole } from '../users/entities/user.entity';
import { BlogService } from './blog.service';
import {
  CreateBlogCommentDto,
  ListBlogCommentsDto,
  UpdateBlogCommentDto,
} from './dto/blog-comment.dto';
import { CreateBlogTagDto, UpdateBlogTagDto } from './dto/blog-tag.dto';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { ListBlogPostsDto } from './dto/list-blog-posts.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';

type BlogUploadFields = {
  cover?: UploadedFile[];
  media?: UploadedFile[];
};

// Single-shot multipart: `cover` (1 file) + `media` (≤20 files) ride
// alongside the text fields. Body images reference uploaded files by
// zero-based `{ ref: N }` index — see CreateBlogPostDto.
const POST_UPLOAD_FIELDS = [
  { name: 'cover', maxCount: 1 },
  { name: 'media', maxCount: 20 },
];

@ApiTags('blog')
@ApiBearerAuth()
@Controller({ version: '1' })
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  // ---- Posts ----

  @OptionalAuth()
  @Get('blog/posts')
  list(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListBlogPostsDto,
  ) {
    return this.blog.list(viewer, query);
  }

  @OptionalAuth()
  @Get('blog/posts/:slug')
  findOne(
    @Param('slug') slug: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.blog.findBySlug(slug, viewer);
  }

  @RequireVerified()
  @Post('blog/posts')
  @UseInterceptors(FileFieldsInterceptor(POST_UPLOAD_FIELDS))
  @ApiConsumes('multipart/form-data')
  create(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreateBlogPostDto,
    @UploadedFiles() files: BlogUploadFields = {},
  ) {
    return this.blog.create(
      userId,
      role,
      dto,
      files.cover?.[0],
      files.media ?? [],
    );
  }

  @RequireVerified()
  @Patch('blog/posts/:id')
  @UseInterceptors(FileFieldsInterceptor(POST_UPLOAD_FIELDS))
  @ApiConsumes('multipart/form-data')
  patch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
    @Body() dto: UpdateBlogPostDto,
    @UploadedFiles() files: BlogUploadFields = {},
  ) {
    return this.blog.patch(
      id,
      actorId,
      actorRole,
      dto,
      files.cover?.[0],
      files.media ?? [],
    );
  }

  @RequireVerified()
  @Delete('blog/posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
  ) {
    await this.blog.softDelete(id, actorId, actorRole);
  }

  // ---- Likes ----

  @RequireVerified()
  @Put('blog/posts/:id/like')
  like(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.blog.like(id, userId);
  }

  @RequireVerified()
  @Delete('blog/posts/:id/like')
  unlike(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.blog.unlike(id, userId);
  }

  // ---- Comments ----

  @OptionalAuth()
  @Get('blog/posts/:id/comments')
  listComments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListBlogCommentsDto,
  ) {
    return this.blog.listTopLevelComments(id, query);
  }

  @OptionalAuth()
  @Get('blog/comments/:id/replies')
  listReplies(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListBlogCommentsDto,
  ) {
    return this.blog.listReplies(id, query);
  }

  @RequireVerified()
  @Post('blog/posts/:id/comments')
  createComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateBlogCommentDto,
  ) {
    return this.blog.createComment(id, userId, dto);
  }

  @RequireVerified()
  @Patch('blog/comments/:id')
  updateComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: UpdateBlogCommentDto,
  ) {
    return this.blog.updateComment(id, actorId, dto);
  }

  @RequireVerified()
  @Delete('blog/comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
  ) {
    await this.blog.deleteComment(id, actorId, actorRole);
  }

  // ---- Tags ----

  @OptionalAuth()
  @Get('blog/tags')
  listTags() {
    return this.blog.listTags();
  }

  @RequireVerified()
  @Post('blog/tags')
  createTag(
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
    @Body() dto: CreateBlogTagDto,
  ) {
    return this.blog.createTag(actorId, actorRole, dto);
  }

  @RequireVerified()
  @Patch('blog/tags/:slug')
  updateTag(
    @Param('slug') slug: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
    @Body() dto: UpdateBlogTagDto,
  ) {
    return this.blog.updateTag(actorId, actorRole, slug, dto);
  }

  @RequireVerified()
  @Delete('blog/tags/:slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTag(
    @Param('slug') slug: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('role') actorRole: UserRole,
  ) {
    await this.blog.deleteTag(actorId, actorRole, slug);
  }
}
