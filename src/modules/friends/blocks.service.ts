import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../users/entities/user.entity';
import { BlockUserDto } from './dto/block-user.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { Friendship } from './entities/friendship.entity';
import { UserBlock } from './entities/user-block.entity';
import { sortPair } from './friends.service';

@Injectable()
export class BlocksService {
  constructor(
    @InjectRepository(UserBlock) private readonly blocks: Repository<UserBlock>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  async block(actorId: string, targetUserId: string, dto: BlockUserDto): Promise<UserBlock> {
    if (actorId === targetUserId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const target = await this.users.findOne({
      where: { id: targetUserId },
      select: ['id'],
    });
    if (!target) throw new NotFoundException('User not found');

    const block = await this.ds.transaction(async (m) => {
      // Cascade: delete any friendship row between the pair (any status).
      const pair = sortPair(actorId, targetUserId);
      const friendshipRow = await m
        .getRepository(Friendship)
        .findOne({ where: pair });
      if (friendshipRow) {
        await m.getRepository(Friendship).delete(pair);
      }

      const existing = await m
        .getRepository(UserBlock)
        .findOne({ where: { blockerId: actorId, blockedId: targetUserId } });
      if (existing) return existing;

      const row = m.getRepository(UserBlock).create({
        blockerId: actorId,
        blockedId: targetUserId,
        reason: dto.reason?.trim() || null,
      });
      await m.getRepository(UserBlock).save(row);
      return row;
    });

    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'friends.block',
      metadata: { reason: dto.reason ?? null },
    });
    return block;
  }

  async unblock(actorId: string, targetUserId: string): Promise<void> {
    const row = await this.blocks.findOne({
      where: { blockerId: actorId, blockedId: targetUserId },
    });
    if (!row) throw new NotFoundException('Not blocked');
    await this.blocks.delete({ blockerId: actorId, blockedId: targetUserId });
    await this.audit.record({
      actorId,
      targetId: targetUserId,
      action: 'friends.unblock',
    });
  }

  async listBlocks(
    actorId: string,
    query: ListRequestsDto,
  ): Promise<{ items: UserBlock[]; total: number; page: number; limit: number }> {
    const [items, total] = await this.blocks.findAndCount({
      where: { blockerId: actorId },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items, total, page: query.page, limit: query.limit };
  }
}
