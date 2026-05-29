import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwksClient } from 'jwks-rsa';
import type { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { AccountStatus, User } from './entities/user.entity';

type SocketData = { userId?: string };

@WebSocketGateway({
  namespace: '/presence',
  cors: {
    origin: [
      'http://localhost:5173',
      'https://turulav-dark.vercel.app',
      /^https:\/\/turulav-dark-[a-z0-9-]+\.vercel\.app$/,
    ],
    credentials: true,
  },
})
export class PresenceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(PresenceGateway.name);
  private readonly sockets = new Map<string, Set<string>>();
  private readonly jwks: JwksClient;
  private readonly legacySecret: string;

  @WebSocketServer() server!: Server;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    const supabaseUrl = this.config.get('supabase.url', { infer: true });
    this.legacySecret = this.config.get('supabase.jwtSecret', { infer: true });
    this.jwks = new JwksClient({
      jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  afterInit(): void {
    this.logger.log('Presence gateway initialised on /presence');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = extractToken(client);
      if (!token) return this.reject(client, 'missing token');

      const userId = await this.verifyToken(token);
      if (!userId) return this.reject(client, 'invalid token');

      const row = await this.users.findOne({
        where: { id: userId },
        select: ['id', 'accountStatus'],
      });
      if (!row || row.accountStatus !== AccountStatus.ACTIVE) {
        return this.reject(client, 'account not active');
      }

      (client.data as SocketData).userId = userId;
      const set = this.sockets.get(userId);
      if (set) {
        set.add(client.id);
      } else {
        this.sockets.set(userId, new Set([client.id]));
        await this.markOnline(userId);
      }
    } catch (err) {
      this.logger.warn(`presence connect rejected: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = (client.data as SocketData).userId;
    if (!userId) return;
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(client.id);
    if (set.size === 0) {
      this.sockets.delete(userId);
      await this.markOffline(userId);
    }
  }

  // Keeps last_active_at fresh for users with live sockets so the cron sweep
  // (which flips stale is_online rows offline after PRESENCE_OFFLINE_THRESHOLD_SECONDS)
  // doesn't kick connected users offline.
  @Interval(60_000)
  async refreshLastActive(): Promise<void> {
    const userIds = Array.from(this.sockets.keys());
    if (userIds.length === 0) return;
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ isOnline: true, lastActiveAt: () => 'now()' })
      .where('id IN (:...userIds)', { userIds })
      .execute();
  }

  async onModuleDestroy(): Promise<void> {
    const userIds = Array.from(this.sockets.keys());
    if (userIds.length === 0) return;
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ isOnline: false, lastActiveAt: () => 'now()' })
      .where('id IN (:...userIds)', { userIds })
      .execute();
  }

  private reject(client: Socket, reason: string): void {
    this.logger.debug(`presence connect rejected: ${reason}`);
    client.disconnect(true);
  }

  private async markOnline(userId: string): Promise<void> {
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ isOnline: true, lastActiveAt: () => 'now()' })
      .where('id = :id', { id: userId })
      .execute();
  }

  private async markOffline(userId: string): Promise<void> {
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ isOnline: false, lastActiveAt: () => 'now()' })
      .where('id = :id', { id: userId })
      .execute();
  }

  private async verifyToken(token: string): Promise<string | null> {
    const header = decodeJwtHeader(token);
    if (!header) return null;
    let secret: string;
    if (header.alg === 'HS256') {
      secret = this.legacySecret;
    } else {
      if (!header.kid) return null;
      const key = await this.jwks.getSigningKey(header.kid);
      secret = key.getPublicKey();
    }
    const claims = await this.jwt.verifyAsync<{ sub?: string }>(token, {
      secret,
      algorithms: ['ES256', 'RS256', 'HS256'],
    });
    return claims.sub ?? null;
  }
}

function extractToken(client: Socket): string | null {
  const auth = (client.handshake.auth as { token?: string } | undefined)?.token;
  if (typeof auth === 'string' && auth.length > 0) return auth;
  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function decodeJwtHeader(token: string): { alg?: string; kid?: string } | null {
  try {
    const [headerSegment] = token.split('.');
    if (!headerSegment) return null;
    const json = Buffer.from(headerSegment, 'base64url').toString('utf8');
    return JSON.parse(json) as { alg?: string; kid?: string };
  } catch {
    return null;
  }
}
