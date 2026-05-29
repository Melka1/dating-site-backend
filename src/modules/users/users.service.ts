import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { AccountStatus, User } from './entities/user.entity';

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'api',
  'system',
  'moderator',
  'mod',
  'staff',
  'team',
  'me',
  'null',
  'undefined',
]);

interface RestorePayload {
  sub: string;
  purpose: 'account_restore';
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async findMe(userId: string): Promise<User> {
    const user = await this.users.findOne({
      where: { id: userId },
      relations: ['profile'],
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async patchMe(userId: string, dto: UpdateMeDto): Promise<User> {
    if (dto.username) {
      const username = dto.username.trim();
      if (RESERVED_USERNAMES.has(username.toLowerCase())) {
        throw new ConflictException('Username is reserved');
      }
      const clash = await this.users.findOne({
        where: { username, id: Not(userId) },
        select: ['id'],
      });
      if (clash) throw new ConflictException('Username already taken');
      await this.users.update({ id: userId }, { username });
    }
    return this.findMe(userId);
  }

  async findPublic(id: string): Promise<User> {
    const user = await this.users.findOne({
      where: { id, accountStatus: AccountStatus.ACTIVE },
      relations: ['profile'],
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async softDelete(userId: string, actorId: string): Promise<{ restoreUrl: string }> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: ['id', 'accountStatus'],
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.accountStatus === AccountStatus.DELETED) {
      // Idempotent: still issue a fresh restore token.
    }

    await this.users.update(
      { id: userId },
      { accountStatus: AccountStatus.DELETED, isOnline: false },
    );

    // Session revocation isn't possible by userId in supabase-js — the admin
    // signOut endpoint takes a JWT. Account-status check in JwtStrategy
    // rejects subsequent requests regardless.

    const restoreToken = await this.jwt.signAsync(
      { sub: userId, purpose: 'account_restore' } satisfies RestorePayload,
      {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
        expiresIn: this.config.get('jwt.restoreExpiresIn', { infer: true }),
      },
    );
    const restoreUrl = `/users/me/restore?token=${restoreToken}`;

    await this.audit.record({
      actorId,
      targetId: userId,
      action: 'user.soft_delete',
      metadata: { restoreUrl },
    });

    // TODO: hand off `restoreUrl` to a transactional email provider. In dev
    // we surface it via the response/audit log; production must email it.
    this.logger.log({ msg: 'soft-delete restore link issued', userId, restoreUrl });

    return { restoreUrl };
  }

  async restore(token: string): Promise<{ userId: string }> {
    let payload: RestorePayload;
    try {
      payload = await this.jwt.verifyAsync<RestorePayload>(token, {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired restore token');
    }
    if (payload.purpose !== 'account_restore' || !payload.sub) {
      throw new UnauthorizedException('Invalid restore token');
    }

    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: ['id', 'accountStatus'],
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.accountStatus !== AccountStatus.DELETED) {
      throw new UnauthorizedException('Account is not in a restorable state');
    }

    await this.users.update({ id: payload.sub }, { accountStatus: AccountStatus.ACTIVE });
    await this.audit.record({
      actorId: payload.sub,
      targetId: payload.sub,
      action: 'user.restore',
    });

    return { userId: payload.sub };
  }
}
