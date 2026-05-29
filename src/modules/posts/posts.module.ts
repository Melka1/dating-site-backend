import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Friendship } from '../friends/entities/friendship.entity';
import { UserBlock } from '../friends/entities/user-block.entity';
import { GroupMember } from '../groups/entities/group-member.entity';
import { Group } from '../groups/entities/group.entity';
import { User } from '../users/entities/user.entity';
import { Comment } from './entities/comment.entity';
import { PostAttachment } from './entities/post-attachment.entity';
import { PostFavorite } from './entities/post-favorite.entity';
import { PostMention } from './entities/post-mention.entity';
import { Post } from './entities/post.entity';
import { Reaction } from './entities/reaction.entity';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Post,
      PostAttachment,
      PostMention,
      Reaction,
      Comment,
      PostFavorite,
      User,
      Group,
      GroupMember,
      Friendship,
      UserBlock,
    ]),
  ],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService, TypeOrmModule],
})
export class PostsModule {}
