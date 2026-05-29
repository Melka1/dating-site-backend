import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Group } from '../groups/entities/group.entity';
import { UserRole } from '../users/entities/user.entity';
import { ListGroupsAdminDto } from './dto/list-groups.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: 'admin/groups', version: '1' })
export class AdminGroupsController {
  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query() query: ListGroupsAdminDto) {
    const where: Record<string, unknown> = {};
    if (query.ownerId) where.ownerId = query.ownerId;
    if (!query.includeDeleted) where.deletedAt = IsNull();
    if (query.suspendedOnly) where.adminSuspendedAt = Not(IsNull());
    if (query.createdAfter && query.createdBefore) {
      where.createdAt = Between(new Date(query.createdAfter), new Date(query.createdBefore));
    } else if (query.createdAfter) {
      where.createdAt = MoreThanOrEqual(new Date(query.createdAfter));
    } else if (query.createdBefore) {
      where.createdAt = LessThan(new Date(query.createdBefore));
    }

    const [items, total] = await this.groups.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items, total, page: query.page, limit: query.limit };
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async suspend(
    @Param('id', ParseUUIDPipe) groupId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    await this.groups.update({ id: groupId }, { adminSuspendedAt: new Date() });
    await this.audit.record({
      actorId,
      action: 'admin.group_suspend',
      metadata: { groupId },
    });
  }

  @Post(':id/unsuspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsuspend(
    @Param('id', ParseUUIDPipe) groupId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    await this.groups.update({ id: groupId }, { adminSuspendedAt: null });
    await this.audit.record({
      actorId,
      action: 'admin.group_unsuspend',
      metadata: { groupId },
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forceSoftDelete(
    @Param('id', ParseUUIDPipe) groupId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    await this.groups.update({ id: groupId }, { deletedAt: new Date() });
    await this.audit.record({
      actorId,
      action: 'admin.group_force_delete',
      metadata: { groupId },
    });
  }

  @Get('flagged')
  flagged() {
    return { items: [], total: 0 };
  }
}
