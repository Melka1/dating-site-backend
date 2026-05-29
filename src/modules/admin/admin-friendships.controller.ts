import {
  BadRequestException,
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
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Friendship } from '../friends/entities/friendship.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { ListFriendshipsAdminDto } from './dto/list-friendships.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: 'admin/friendships', version: '1' })
export class AdminFriendshipsController {
  constructor(
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query() query: ListFriendshipsAdminDto) {
    const qb = this.friendships.createQueryBuilder('f');

    if (query.userId) {
      qb.andWhere(
        new Brackets((b) =>
          b.where('f.user_low = :uid', { uid: query.userId }).orWhere('f.user_high = :uid', {
            uid: query.userId,
          }),
        ),
      );
    }
    if (query.status) qb.andWhere('f.status = :status', { status: query.status });

    if (query.createdAfter && query.createdBefore) {
      qb.andWhere('f.created_at BETWEEN :a AND :b', {
        a: new Date(query.createdAfter),
        b: new Date(query.createdBefore),
      });
    } else if (query.createdAfter) {
      qb.andWhere('f.created_at >= :a', { a: new Date(query.createdAfter) });
    } else if (query.createdBefore) {
      qb.andWhere('f.created_at < :b', { b: new Date(query.createdBefore) });
    }

    qb.orderBy('f.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }

  @Delete(':userLow/:userHigh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forceDelete(
    @Param('userLow', ParseUUIDPipe) userLow: string,
    @Param('userHigh', ParseUUIDPipe) userHigh: string,
    @CurrentUser('sub') actorId: string,
  ) {
    if (userLow >= userHigh) {
      throw new BadRequestException('userLow must be < userHigh');
    }
    const row = await this.friendships.findOne({ where: { userLow, userHigh } });
    if (!row) throw new NotFoundException('Friendship not found');
    await this.friendships.delete({ userLow, userHigh });
    await this.audit.record({
      actorId,
      action: 'admin.friendship_force_delete',
      metadata: { userLow, userHigh, status: row.status },
    });
  }

  @Post('recount/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recount(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    const user = await this.users.findOne({ where: { id: userId }, select: ['id', 'friendCount'] });
    if (!user) throw new NotFoundException('User not found');
    const rows: Array<{ count: string }> = await this.ds.query(
      `select count(*)::text as count
         from public.friendships
        where status = 'accepted' and (user_low = $1 or user_high = $1)`,
      [userId],
    );
    const before = user.friendCount;
    const after = Number(rows[0]?.count ?? 0);
    await this.users.update({ id: userId }, { friendCount: after });
    await this.audit.record({
      actorId,
      targetId: userId,
      action: 'admin.friendship_recount',
      metadata: { before, after },
    });
  }

  @Get('flagged')
  flagged() {
    return { items: [], total: 0 };
  }
}
