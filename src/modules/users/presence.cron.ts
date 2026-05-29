import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { User } from './entities/user.entity';

// Safety net for the presence mirror: catches users left flagged online when
// the browser closed without firing a clean DELETE /me/presence beacon (mobile
// app kill, OS reaping the tab, lost network on close, etc.).
//
// NOTE: this uses @nestjs/schedule which only fires inside a long-running
// process. On Vercel serverless deploys it will NOT run — you need a Vercel
// Cron Job in vercel.json pointing at an HTTP endpoint that triggers sweep().
@Injectable()
export class PresenceCron {
  private readonly logger = new Logger(PresenceCron.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    const ttl = this.config.get('presence.offlineThresholdSeconds', { infer: true });
    const res = await this.users
      .createQueryBuilder()
      .update(User)
      .set({ isOnline: false })
      .where('is_online = true')
      .andWhere(`last_active_at < (now() - make_interval(secs => :ttl))`, { ttl })
      .execute();
    if (res.affected && res.affected > 0) {
      this.logger.debug(`Presence sweep marked ${res.affected} user(s) offline`);
    }
  }
}
