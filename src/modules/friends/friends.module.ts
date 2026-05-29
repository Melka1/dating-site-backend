import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { BlocksController } from './blocks.controller';
import { BlocksService } from './blocks.service';
import { Friendship } from './entities/friendship.entity';
import { UserBlock } from './entities/user-block.entity';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';

@Module({
  imports: [TypeOrmModule.forFeature([Friendship, UserBlock, User])],
  controllers: [FriendsController, BlocksController],
  providers: [FriendsService, BlocksService],
  exports: [FriendsService, BlocksService, TypeOrmModule],
})
export class FriendsModule {}
