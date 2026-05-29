import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { StorageModule } from './common/storage/storage.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { loggerConfigFactory } from './config/logger.config';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmailVerifiedGuard } from './modules/auth/guards/email-verified.guard';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { BlogModule } from './modules/blog/blog.module';
import { FriendsModule } from './modules/friends/friends.module';
import { GroupsModule } from './modules/groups/groups.module';
import { HealthModule } from './modules/health/health.module';
import { PostsModule } from './modules/posts/posts.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { RetentionModule } from './modules/retention/retention.module';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
    ScheduleModule.forRoot(),
    LoggerModule.forRootAsync({ useFactory: loggerConfigFactory }),
    // Two named throttlers, exactly one applies per request:
    //  - `default` — for authenticated callers, keyed by user.sub
    //  - `guest`   — for unauthenticated callers, keyed by client IP
    // Selection is via `skipIf` reading req.user, which JwtAuthGuard populates.
    // JwtAuthGuard MUST therefore run before ThrottlerGuard — see the provider
    // order below.
    ThrottlerModule.forRootAsync({
      useFactory: () => [
        {
          name: 'default',
          ttl: Number(process.env.THROTTLE_TTL ?? 60) * 1000,
          limit: Number(process.env.THROTTLE_LIMIT ?? 100),
          skipIf: (ctx: ExecutionContext) =>
            !ctx.switchToHttp().getRequest<Request & { user?: unknown }>().user,
          getTracker: (req: Record<string, any>) =>
            Promise.resolve(`user:${req.user?.sub ?? 'anon'}`),
        },
        {
          name: 'guest',
          ttl: Number(process.env.THROTTLE_GUEST_TTL ?? 60) * 1000,
          limit: Number(process.env.THROTTLE_GUEST_LIMIT ?? 30),
          skipIf: (ctx: ExecutionContext) =>
            !!ctx.switchToHttp().getRequest<Request & { user?: unknown }>().user,
          getTracker: (req: Record<string, any>) =>
            Promise.resolve(`ip:${req.ip ?? 'unknown'}`),
        },
      ],
    }),
    DatabaseModule,
    SupabaseModule,
    StorageModule,
    AuditModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    GroupsModule,
    FriendsModule,
    PostsModule,
    BlogModule,
    AdminModule,
    RetentionModule,
  ],
  providers: [
    // Order matters: JwtAuthGuard must populate req.user BEFORE ThrottlerGuard
    // reads it for bucket selection. EmailVerifiedGuard + RolesGuard run after
    // so they see both auth state and throttle decisions.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
