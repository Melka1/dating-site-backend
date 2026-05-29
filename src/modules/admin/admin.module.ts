import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Friendship } from '../friends/entities/friendship.entity';
import { Group } from '../groups/entities/group.entity';
import { User } from '../users/entities/user.entity';
import { AdminFriendshipsController } from './admin-friendships.controller';
import { AdminGroupsController } from './admin-groups.controller';
import { AdminProfilesController } from './admin-profiles.controller';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Group, Friendship])],
  controllers: [
    AdminUsersController,
    AdminProfilesController,
    AdminGroupsController,
    AdminFriendshipsController,
  ],
})
export class AdminModule {}
