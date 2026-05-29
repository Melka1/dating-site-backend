import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccountStatus, User, UserRole } from '../users/entities/user.entity';
import { ListUsersDto } from './dto/list-users.dto';
import { SetRoleDto } from './dto/set-role.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query() query: ListUsersDto) {
    const where: Record<string, unknown> = {};
    if (query.status) where.accountStatus = query.status;
    if (query.role) where.role = query.role;
    if (query.onboardingCompleted !== undefined) {
      where.onboardingCompleted = query.onboardingCompleted;
    }
    if (query.createdAfter && query.createdBefore) {
      where.createdAt = Between(new Date(query.createdAfter), new Date(query.createdBefore));
    } else if (query.createdAfter) {
      where.createdAt = MoreThanOrEqual(new Date(query.createdAfter));
    } else if (query.createdBefore) {
      where.createdAt = LessThan(new Date(query.createdBefore));
    }

    const [items, total] = await this.users.findAndCount({
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
    @Param('id', ParseUUIDPipe) targetId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.mutateStatus(targetId, actorId, AccountStatus.SUSPENDED, 'admin.suspend');
  }

  @Post(':id/unsuspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsuspend(
    @Param('id', ParseUUIDPipe) targetId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.mutateStatus(targetId, actorId, AccountStatus.ACTIVE, 'admin.unsuspend');
  }

  @Post(':id/ban')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ban(
    @Param('id', ParseUUIDPipe) targetId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.mutateStatus(targetId, actorId, AccountStatus.BANNED, 'admin.ban');
  }

  @Post(':id/role')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setRole(
    @Param('id', ParseUUIDPipe) targetId: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: SetRoleDto,
  ) {
    const user = await this.users.findOne({ where: { id: targetId }, select: ['id', 'role'] });
    if (!user) throw new NotFoundException('User not found');
    await this.users.update({ id: targetId }, { role: dto.role });
    await this.audit.record({
      actorId,
      targetId,
      action: 'admin.set_role',
      metadata: { from: user.role, to: dto.role },
    });
  }

  private async mutateStatus(
    targetId: string,
    actorId: string,
    next: AccountStatus,
    action: string,
  ): Promise<void> {
    const user = await this.users.findOne({
      where: { id: targetId },
      select: ['id', 'accountStatus'],
    });
    if (!user) throw new NotFoundException('User not found');
    await this.users.update({ id: targetId }, { accountStatus: next });
    await this.audit.record({
      actorId,
      targetId,
      action,
      metadata: { from: user.accountStatus, to: next },
    });
  }
}
