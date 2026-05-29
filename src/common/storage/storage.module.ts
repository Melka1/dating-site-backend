import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

// SupabaseAdminService comes from the global SupabaseModule.
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
