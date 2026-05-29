import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'path';
import type { AppConfig } from '../config/configuration';

export const typeOrmOptions = (
  config: ConfigService<AppConfig, true>,
): TypeOrmModuleOptions => {
  const ssl = config.get('database.ssl', { infer: true });
  return {
    type: 'postgres',
    host: config.get('database.host', { infer: true }),
    port: config.get('database.port', { infer: true }),
    username: config.get('database.username', { infer: true }),
    password: config.get('database.password', { infer: true }),
    database: config.get('database.name', { infer: true }),
    schema: config.get('database.schema', { infer: true }),
    // Supabase requires SSL. rejectUnauthorized=false accepts the Supabase-managed cert chain.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    autoLoadEntities: true,
    synchronize: config.get('database.synchronize', { infer: true }),
    logging: config.get('database.logging', { infer: true }),
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsRun: false,
    migrationsTableName: 'typeorm_migrations',
  };
};
