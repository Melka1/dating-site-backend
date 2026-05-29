import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { join } from 'path';

dotenv.config();

const ssl = (process.env.DATABASE_SSL ?? 'true').toLowerCase() === 'true';

/**
 * DataSource used by the TypeORM CLI (migrations). The running Nest app
 * builds its own DataSource via DatabaseModule.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME ?? 'postgres',
  schema: process.env.DATABASE_SCHEMA ?? 'public',
  ssl: ssl ? { rejectUnauthorized: false } : false,
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: (process.env.DATABASE_LOGGING ?? 'false').toLowerCase() === 'true',
});
