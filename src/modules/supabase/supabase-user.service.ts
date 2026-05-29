import { Inject, Injectable, Scope, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUEST } from '@nestjs/core';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration';

/**
 * Request-scoped Supabase client that forwards the caller's JWT so Postgres
 * RLS policies see `auth.uid()` as the authenticated user.
 */
@Injectable({ scope: Scope.REQUEST })
export class SupabaseUserService {
  readonly client: SupabaseClient;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Inject(REQUEST) req: Request,
  ) {
    const url = config.get('supabase.url', { infer: true });
    const anonKey = config.get('supabase.anonKey', { infer: true });
    const header = req.headers.authorization ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('Missing bearer token');

    this.client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }
}
