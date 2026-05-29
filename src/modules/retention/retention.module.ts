import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogModule } from '../blog/blog.module';
import { Group } from '../groups/entities/group.entity';
import { PostsModule } from '../posts/posts.module';
import { User } from '../users/entities/user.entity';
import { RetentionCron } from './retention.cron';

@Module({
  imports: [TypeOrmModule.forFeature([User, Group]), PostsModule, BlogModule],
  providers: [RetentionCron],
})
export class RetentionModule {}
