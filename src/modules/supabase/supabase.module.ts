import { Global, Module } from '@nestjs/common';
import { SupabaseAdminService } from './supabase-admin.service';
import { SupabaseUserService } from './supabase-user.service';

@Global()
@Module({
  providers: [SupabaseAdminService, SupabaseUserService],
  exports: [SupabaseAdminService, SupabaseUserService],
})
export class SupabaseModule {}
