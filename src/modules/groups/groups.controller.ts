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
import { CreateGroupDto } from './dto/create-group.dto';
import {
  BanMemberDto,
  InviteMembersDto,
  SetGroupRoleDto,
  TransferOwnerDto,
} from './dto/membership.dto';
import { RenameSlugDto } from './dto/rename-slug.dto';
import { SearchGroupsDto } from './dto/search-groups.dto';
import { SuggestedGroupsDto } from './dto/suggested-groups.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import {
  GroupMemberRole,
  GroupMemberStatus,
} from './entities/group-member.entity';
import { GroupsService } from './groups.service';

type GroupUploadFields = {
  avatar?: UploadedFile[];
  cover?: UploadedFile[];
};

const GROUP_UPLOAD_FIELDS = [
  { name: 'avatar', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
];

@ApiTags('groups')
@ApiBearerAuth()
@Controller({ path: 'groups', version: '1' })
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  // ---- CRUD ----

  @RequireVerified()
  @Post()
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateGroupDto) {
    return this.groups.create(userId, dto);
  }

  @OptionalAuth()
  @Get()
  list(@CurrentViewer() viewer: Viewer, @Query() query: SearchGroupsDto) {
    return this.groups.listForViewer(viewer, query);
  }

  @OptionalAuth()
  @Get('search')
  search(@CurrentViewer() viewer: Viewer, @Query() query: SearchGroupsDto) {
    return this.groups.listForViewer(viewer, query);
  }

  // /groups/me lists "groups I'm in" — meaningless without auth.
  @Get('me')
  listMine(@CurrentViewer() viewer: Viewer) {
    return this.groups.listMine(viewer);
  }

  @Get('suggestions')
  async suggestions(
    @CurrentUser('sub') userId: string,
    @Query() query: SuggestedGroupsDto,
  ) {
    const items = await this.groups.suggestGroups(userId, query.limit);
    return { items };
  }

  @OptionalAuth()
  @Get(':slug')
  findOne(@Param('slug') slug: string, @CurrentViewer() viewer: Viewer) {
    return this.groups.findBySlug(slug, viewer);
  }

  @RequireVerified()
  @Patch(':id')
  @UseInterceptors(FileFieldsInterceptor(GROUP_UPLOAD_FIELDS))
  @ApiConsumes('multipart/form-data', 'application/json')
  patch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: UpdateGroupDto,
    @UploadedFiles() files: GroupUploadFields = {},
  ) {
    return this.groups.patch(id, actorId, dto, files.avatar?.[0], files.cover?.[0]);
  }

  @RequireVerified()
  @Post(':id/slug')
  renameSlug(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: RenameSlugDto,
  ) {
    return this.groups.renameSlug(id, actorId, dto.slug);
  }

  @RequireVerified()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.groups.softDelete(id, actorId);
  }

  @RequireVerified()
  @Post(':id/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.groups.restore(id, actorId);
  }

  @RequireVerified()
  @Post(':id/transfer-owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  async transferOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: TransferOwnerDto,
  ) {
    await this.groups.transferOwner(id, actorId, dto.newOwnerId);
  }

  // ---- Membership ----

  @Get(':id/members')
  listMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') viewerId: string,
    @Query('status') status?: GroupMemberStatus,
    @Query('role') role?: GroupMemberRole,
  ) {
    return this.groups.listMembers(id, viewerId, status, role);
  }

  @RequireVerified()
  @Post(':id/join')
  selfJoin(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('sub') userId: string) {
    return this.groups.selfJoin(id, userId);
  }

  @RequireVerified()
  @Post(':id/join-request')
  requestJoin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.groups.requestJoin(id, userId);
  }

  @RequireVerified()
  @Post(':id/join-request/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.groups.cancelRequest(id, userId);
  }

  @RequireVerified()
  @Post(':id/invites')
  invite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: InviteMembersDto,
  ) {
    return this.groups.invite(id, actorId, dto.userIds);
  }

  @RequireVerified()
  @Post(':id/invites/accept')
  acceptInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.groups.acceptInvite(id, userId);
  }

  @RequireVerified()
  @Post(':id/invites/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async declineInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.groups.declineInvite(id, userId);
  }

  @RequireVerified()
  @Post(':id/members/:userId/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.groups.approve(id, actorId, targetUserId);
  }

  @RequireVerified()
  @Post(':id/members/:userId/deny')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deny(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    await this.groups.deny(id, actorId, targetUserId);
  }

  @RequireVerified()
  @Post(':id/members/:userId/role')
  setRole(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() dto: SetGroupRoleDto,
  ) {
    return this.groups.setRole(id, actorId, targetUserId, dto.role as GroupMemberRole);
  }

  @RequireVerified()
  @Post(':id/members/:userId/kick')
  @HttpCode(HttpStatus.NO_CONTENT)
  async kick(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    await this.groups.kick(id, actorId, targetUserId);
  }

  @RequireVerified()
  @Post(':id/members/:userId/ban')
  ban(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() dto: BanMemberDto,
  ) {
    return this.groups.ban(id, actorId, targetUserId, dto);
  }

  @RequireVerified()
  @Post(':id/members/:userId/unban')
  unban(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.groups.unban(id, actorId, targetUserId);
  }

  @RequireVerified()
  @Delete(':id/members/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('sub') userId: string) {
    await this.groups.leave(id, userId);
  }
}
