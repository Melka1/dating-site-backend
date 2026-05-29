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
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { UploadedFile } from '../../common/storage/storage.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentViewer } from '../../common/decorators/current-viewer.decorator';
import type { Viewer } from '../../common/viewer';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { RequireVerified } from '../auth/decorators/require-verified.decorator';
import { ActivityFeedQueryDto } from './dto/activity-feed.dto';
import {
  CreateCommentDto,
  ListCommentsDto,
  UpdateCommentDto,
} from './dto/comment.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { SetReactionDto } from './dto/reaction.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { UserMediaQueryDto } from './dto/user-media.dto';
import { PostsService } from './posts.service';

@ApiTags('posts')
@ApiBearerAuth()
@Controller({ version: '1' })
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // ---- Activity feed ----

  @OptionalAuth()
  @Get('users/:userId/activity')
  activity(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ActivityFeedQueryDto,
  ) {
    return this.posts.activityFeed(userId, viewer, query);
  }

  @OptionalAuth()
  @Get('users/:userId/media')
  userMedia(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentViewer() viewer: Viewer,
    @Query() query: UserMediaQueryDto,
  ) {
    return this.posts.userMedia(userId, viewer, query);
  }

  // /users/me/favorites stays auth-required — guests have no favorites.
  @Get('users/me/favorites')
  myFavorites(
    @CurrentUser('sub') viewerId: string,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ActivityFeedQueryDto,
  ) {
    return this.posts.activityFeed(
      viewerId,
      viewer,
      { ...query, lens: 'favorites' },
    );
  }

  // ---- Posts CRUD ----

  // Multipart upload — see StorageService for mime + size caps (10MB photos,
  // 50MB videos, 10 files max). Text fields (body/audience/groupId) ride
  // alongside the `files` field in a single multipart/form-data request.
  @RequireVerified()
  @Post('posts')
  @UseInterceptors(FilesInterceptor('files', 10))
  @ApiConsumes('multipart/form-data')
  create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreatePostDto,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    return this.posts.create(userId, dto, files);
  }

  @OptionalAuth()
  @Get('posts/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.posts.findOne(id, viewer);
  }

  @RequireVerified()
  @Patch('posts/:id')
  patch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.posts.patch(id, actorId, dto);
  }

  @RequireVerified()
  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.posts.softDelete(id, actorId);
  }

  // ---- Reactions ----

  @RequireVerified()
  @Put('posts/:id/reactions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async react(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: SetReactionDto,
  ) {
    await this.posts.setReaction(id, userId, dto.type);
  }

  @RequireVerified()
  @Delete('posts/:id/reactions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unreact(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.posts.clearReaction(id, userId);
  }

  // ---- Comments ----

  @OptionalAuth()
  @Get('posts/:id/comments')
  listComments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListCommentsDto,
  ) {
    return this.posts.listTopLevelComments(id, viewer, query);
  }

  @RequireVerified()
  @Post('posts/:id/comments')
  createComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.posts.createComment(id, userId, dto);
  }

  @OptionalAuth()
  @Get('comments/:id/replies')
  listReplies(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListCommentsDto,
  ) {
    return this.posts.listReplies(id, viewer, query);
  }

  @RequireVerified()
  @Patch('comments/:id')
  updateComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.posts.updateComment(id, actorId, dto);
  }

  @RequireVerified()
  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.posts.deleteComment(id, actorId);
  }

  // ---- Favorites ----

  @RequireVerified()
  @Put('posts/:id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  async favorite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.posts.favorite(id, userId);
  }

  @RequireVerified()
  @Delete('posts/:id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unfavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.posts.unfavorite(id, userId);
  }
}
