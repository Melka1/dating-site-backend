import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type { AppConfig } from '../../config/configuration';

@Injectable()
export class SupabaseAdminService {
  readonly client: SupabaseClient;

  private readonly url: string;
  private readonly anonKey: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.url = config.get('supabase.url', { infer: true });
    this.anonKey = config.get('supabase.anonKey', { infer: true });
    const serviceRoleKey = config.get('supabase.serviceRoleKey', { infer: true });
    this.client = createClient(this.url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Ephemeral anon-keyed client for non-admin GoTrue calls (signInWithPassword,
   * refreshSession, resend). Never reuse the shared `client` for these — those
   * calls write the resulting session back onto the client, which would mean
   * every subsequent Storage / RLS call from the singleton admin client runs
   * as the signed-in user instead of service-role.
   */
  newGoTrueClient(): SupabaseClient {
    return createClient(this.url, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
}
