import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { BlogService } from '../blog/blog.service';
import { Group } from '../groups/entities/group.entity';
import { PostsService } from '../posts/posts.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AccountStatus, User } from '../users/entities/user.entity';

@Injectable()
export class RetentionCron {
  private readonly logger = new Logger(RetentionCron.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly supabase: SupabaseAdminService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly posts: PostsService,
    private readonly blog: BlogService,
  ) {}

  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async purgeDeletedAccounts(): Promise<void> {
    const graceDays = this.config.get('retention.softDeleteGraceDays', { infer: true });
    const cutoff = new Date(Date.now() - graceDays * 86_400_000);
    const expired = await this.users.find({
      where: { accountStatus: AccountStatus.DELETED, deletedAt: LessThan(cutoff) },
      select: ['id'],
    });
    if (expired.length === 0) return;

    this.logger.log(`Retention sweep: hard-deleting ${expired.length} expired account(s)`);
    for (const u of expired) {
      const { error } = await this.supabase.client.auth.admin.deleteUser(u.id);
      if (error) {
        this.logger.warn(`Failed to hard-delete ${u.id}: ${error.message}`);
        continue;
      }
      // FK cascade removes public.users + public.profiles + downstream rows.
      await this.audit.record({ action: 'retention.hard_delete', targetId: u.id });
    }
  }

  @Cron('30 3 * * *', { timeZone: 'UTC' })
  async purgeDeletedPosts(): Promise<void> {
    // Posts and comments are hard-deleted after the same grace window.
    // The spec calls for 30 days; we use the global softDeleteGraceDays config
    // so all retention windows stay in sync.
    const graceDays = this.config.get('retention.softDeleteGraceDays', { infer: true });
    try {
      const { posts, comments } = await this.posts.purgeExpiredSoftDeleted(graceDays);
      if (posts > 0 || comments > 0) {
        this.logger.log(
          `Retention sweep: hard-deleted ${posts} post(s), ${comments} comment(s)`,
        );
        await this.audit.record({
          action: 'retention.posts_hard_delete',
          metadata: { posts, comments },
        });
      }
    } catch (err) {
      this.logger.warn(`Post retention sweep failed: ${(err as Error).message}`);
    }
  }

  @Cron('45 3 * * *', { timeZone: 'UTC' })
  async purgeDeletedBlogPosts(): Promise<void> {
    // Same grace window as posts/groups; keeps all retention knobs unified.
    const graceDays = this.config.get('retention.softDeleteGraceDays', { infer: true });
    try {
      const { posts, comments } = await this.blog.purgeExpiredSoftDeleted(graceDays);
      if (posts > 0 || comments > 0) {
        this.logger.log(
          `Retention sweep: hard-deleted ${posts} blog post(s), ${comments} comment(s)`,
        );
        await this.audit.record({
          action: 'retention.blog_hard_delete',
          metadata: { posts, comments },
        });
      }
    } catch (err) {
      this.logger.warn(`Blog retention sweep failed: ${(err as Error).message}`);
    }
  }

  @Cron('15 3 * * *', { timeZone: 'UTC' })
  async purgeDeletedGroups(): Promise<void> {
    const graceDays = this.config.get('retention.softDeleteGraceDays', { infer: true });
    const cutoff = new Date(Date.now() - graceDays * 86_400_000);
    const expired = await this.groups.find({
      where: { deletedAt: LessThan(cutoff) },
      select: ['id'],
    });
    if (expired.length === 0) return;

    this.logger.log(`Retention sweep: hard-deleting ${expired.length} expired group(s)`);
    for (const g of expired) {
      try {
        await this.groups.delete({ id: g.id });
        // FK cascade clears group_members.
        await this.audit.record({
          action: 'retention.group_hard_delete',
          metadata: { groupId: g.id },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to hard-delete group ${g.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
