import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import type { AppConfig } from '../../../config/configuration';
import { AccountStatus, User, UserRole } from '../../users/entities/user.entity';
import type { JwtPayload, SupabaseJwtClaims } from '../types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<AppConfig, true>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    const supabaseUrl = config.get('supabase.url', { infer: true });
    const legacySecret = config.get('supabase.jwtSecret', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Supabase signs access tokens with asymmetric keys (ES256/RS256) when
      // the project uses the new sb_publishable_*/sb_secret_* API keys. We
      // pull the public key from the JWKS endpoint and fall back to the
      // legacy HS256 secret for tokens still signed symmetrically.
      secretOrKeyProvider: (
        request: unknown,
        rawJwtToken: string,
        done: (err: Error | null, secret?: string | Buffer) => void,
      ) => {
        const header = decodeHeader(rawJwtToken);
        if (header?.alg === 'HS256') {
          return done(null, legacySecret);
        }
        return passportJwtSecret({
          cache: true,
          rateLimit: true,
          jwksRequestsPerMinute: 10,
          jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
        })(request as never, rawJwtToken, done as never);
      },
      algorithms: ['ES256', 'RS256', 'HS256'],
    });
  }

  async validate(claims: SupabaseJwtClaims): Promise<JwtPayload> {
    if (!claims.sub || !claims.email) {
      throw new UnauthorizedException('Invalid token claims');
    }

    // Supabase's local build doesn't always emit `email_verified` in the JWT,
    // so we read the source of truth from auth.users on every request.
    const rows = await this.users.query<
      Array<{ role: UserRole; account_status: AccountStatus; confirmed_at: Date | null }>
    >(
      `select u.role, u.account_status, au.confirmed_at
         from public.users u
         join auth.users au on au.id = u.id
        where u.id = $1`,
      [claims.sub],
    );
    const row = rows[0];
    if (!row) throw new UnauthorizedException('User not provisioned');
    if (row.account_status === AccountStatus.BANNED) {
      throw new UnauthorizedException('Account banned');
    }
    if (row.account_status === AccountStatus.DELETED) {
      throw new UnauthorizedException('Account deleted');
    }

    return {
      sub: claims.sub,
      email: claims.email,
      emailConfirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
      role: row.role ?? UserRole.USER,
    };
  }
}

function decodeHeader(token: string): { alg?: string; kid?: string } | null {
  try {
    const [headerSegment] = token.split('.');
    if (!headerSegment) return null;
    const json = Buffer.from(headerSegment, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
