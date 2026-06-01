import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `seeking_professions` to profiles so mutual profession matching can
 * mirror the existing gender pair (`gender` ↔ `seeking`): a candidate
 * surfaces only when the viewer's profession is in their seeking list (or
 * the 'any' wildcard). GIN-indexed for array containment lookups.
 */
export class ProfileSeekingProfessions1723000000000 implements MigrationInterface {
  name = 'ProfileSeekingProfessions1723000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table public.profiles add column seeking_professions text[] not null default '{}'`,
    );
    await queryRunner.query(
      `create index profiles_seeking_professions_gin on public.profiles using gin (seeking_professions)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists public.profiles_seeking_professions_gin`);
    await queryRunner.query(`alter table public.profiles drop column seeking_professions`);
  }
}
