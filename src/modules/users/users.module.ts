import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesModule } from '../profiles/profiles.module';
import { User } from './entities/user.entity';
import { PresenceCron } from './presence.cron';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User]), JwtModule.register({}), ProfilesModule],
  controllers: [UsersController],
  providers: [UsersService, PresenceCron],
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule {}
