import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RLS floor tightening. See docs/guest-access.md → "The two-layer contract"
 * for the rationale. Two independent changes:
 *
 * 1. `profiles_select` — require `auth.uid() IS NOT NULL` on the
 *    `members_only` branch, so an anon-role direct-DB client cannot read
 *    members-only profiles.
 * 2. `audit_log` — enable RLS with no policies (deny-all to non-superusers).
 */
export class TightenRlsFloor1718000000000 implements MigrationInterface {
  name = 'TightenRlsFloor1718000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- profiles_select ----
    await queryRunner.query(`drop policy if exists profiles_select on public.profiles`);
    await queryRunner.query(`
      create policy profiles_select on public.profiles
        for select using (
          user_id = auth.uid()
          or (
            visibility = 'public'
            and exists (
              select 1 from public.users u
              where u.id = profiles.user_id
                and u.account_status = 'active'
            )
          )
          or (
            visibility = 'members_only'
            and auth.uid() is not null
            and exists (
              select 1 from public.users u
              where u.id = profiles.user_id
                and u.account_status = 'active'
            )
          )
        )
    `);

    // ---- audit_log ----
    // No policies = deny-all for non-superusers. The Nest backend connects as
    // the postgres role and continues to read/write unaffected.
    await queryRunner.query(`alter table public.audit_log enable row level security`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table public.audit_log disable row level security`);

    await queryRunner.query(`drop policy if exists profiles_select on public.profiles`);
    await queryRunner.query(`
      create policy profiles_select on public.profiles
        for select using (
          user_id = auth.uid()
          or (
            visibility in ('public','members_only')
            and exists (
              select 1 from public.users u
              where u.id = profiles.user_id
                and u.account_status = 'active'
            )
          )
        )
    `);
  }
}
