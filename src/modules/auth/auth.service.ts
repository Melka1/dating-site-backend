import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AccountStatus, User } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { SignupDto } from './dto/signup.dto';
import {
  UsernameSuggestionsDto,
  UsernameSuggestionsResponse,
} from './dto/username-suggestions.dto';
import {
  buildCandidates,
  isValidUsername,
  slugifyDisplayName,
} from './username-suggester';

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'api',
  'system',
  'moderator',
  'mod',
  'staff',
  'team',
  'me',
  'null',
  'undefined',
]);

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseAdminService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async signup(dto: SignupDto): Promise<{ userId: string; emailConfirmationRequired: boolean }> {
    const username = dto.username.trim().toLowerCase();
    const displayName = dto.displayName.trim();

    if (!isValidUsername(username)) {
      throw new BadRequestException('Invalid username format');
    }
    if (RESERVED_USERNAMES.has(username)) {
      throw new ConflictException('Username is reserved');
    }

    const existing = await this.users.findOne({ where: { username } });
    if (existing) throw new ConflictException('Username already taken');

    const { data, error } = await this.supabase.client.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      user_metadata: { username, display_name: displayName },
      email_confirm: false,
    });
    if (error || !data.user) {
      if (error?.message?.toLowerCase().includes('already registered')) {
        throw new ConflictException('Email already registered');
      }
      throw new BadRequestException(error?.message ?? 'Signup failed');
    }

    return {
      userId: data.user.id,
      emailConfirmationRequired: !data.user.email_confirmed_at,
    };
  }

  /**
   * Suggest a username for a given display name. Returns the canonical slug
   * derived from `displayName` plus a short list of available alternates
   * when the canonical one is already taken or reserved. Designed to be
   * called live as the user types — uses a single bulk lookup against the
   * `users` table for all candidates at once.
   */
  async suggestUsernames(dto: UsernameSuggestionsDto): Promise<UsernameSuggestionsResponse> {
    const baseSlug = slugifyDisplayName(dto.displayName);
    const candidates = buildCandidates(baseSlug);

    if (candidates.length === 0) {
      // displayName slugified to nothing usable — return an empty canonical
      // and let the client prompt the user to type more.
      return { username: '', available: false, suggestions: [] };
    }

    const reserved = candidates.filter((c) => RESERVED_USERNAMES.has(c));
    const taken = new Set(reserved);

    const rows = await this.users.find({
      where: { username: In(candidates) },
      select: ['username'],
    });
    for (const r of rows) taken.add(r.username.toLowerCase());

    const canonical = candidates[0];
    const canonicalAvailable = isValidUsername(canonical) && !taken.has(canonical);

    if (canonicalAvailable) {
      return { username: canonical, available: true, suggestions: [] };
    }

    const suggestions = candidates.filter((c) => c !== canonical && !taken.has(c));
    return { username: canonical, available: false, suggestions };
  }

  async login(dto: LoginDto): Promise<{ session: AuthSession; userId: string }> {
    const gotrue = this.supabase.newGoTrueClient();
    const { data, error } = await gotrue.auth.signInWithPassword({
      email: dto.email,
      password: dto.password,
    });
    if (error || !data.session || !data.user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const account = await this.users.findOne({
      where: { id: data.user.id },
      select: ['id', 'accountStatus'],
    });
    if (account?.accountStatus === AccountStatus.DELETED) {
      await this.supabase.client.auth.admin
        .signOut(data.session.access_token)
        .catch(() => undefined);
      throw new ForbiddenException({
        code: 'ACCOUNT_DELETED',
        message: 'Account is pending deletion. Restore it via the email link.',
      });
    }
    if (account?.accountStatus === AccountStatus.BANNED) {
      await this.supabase.client.auth.admin
        .signOut(data.session.access_token)
        .catch(() => undefined);
      throw new ForbiddenException({ code: 'ACCOUNT_BANNED', message: 'Account banned' });
    }

    return {
      userId: data.user.id,
      session: this.mapSession(data.session),
    };
  }

  async logout(accessToken: string): Promise<void> {
    // Supabase GoTrue accepts the caller's bearer token to revoke their session.
    await this.supabase.client.auth.admin.signOut(accessToken);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const gotrue = this.supabase.newGoTrueClient();
    const { data, error } = await gotrue.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) throw new UnauthorizedException('Invalid refresh token');
    return this.mapSession(data.session);
  }

  async resendVerification(dto: ResendVerificationDto): Promise<void> {
    const gotrue = this.supabase.newGoTrueClient();
    const { error } = await gotrue.auth.resend({
      type: 'signup',
      email: dto.email,
    });
    if (error && error.status === 429) {
      throw new BadRequestException('Too many verification emails requested');
    }
    // Any other error is swallowed so we don't leak account existence.
  }

  private mapSession(session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  }): AuthSession {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      tokenType: session.token_type,
    };
  }
}
