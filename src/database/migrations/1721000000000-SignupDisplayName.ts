import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Signup now collects the user-entered display name alongside the
 * generated username handle. Update `handle_new_user` so the auth trigger
 * uses `raw_user_meta_data->>'display_name'` for `profiles.display_name`
 * when present, falling back to the username (old behavior) and then to
 * the email's local part.
 */
export class SignupDisplayName1721000000000 implements MigrationInterface {
  name = 'SignupDisplayName1721000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create or replace function public.handle_new_user()
      returns trigger
      language plpgsql
      security definer as $$
      declare
        v_username text;
        v_display_name text;
      begin
        v_username := coalesce(
          new.raw_user_meta_data->>'username',
          split_part(new.email, '@', 1)
        );
        v_display_name := coalesce(
          nullif(new.raw_user_meta_data->>'display_name', ''),
          v_username
        );
        insert into public.users (id, username) values (new.id, v_username);
        insert into public.profiles (user_id, display_name) values (new.id, v_display_name);
        return new;
      end;
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create or replace function public.handle_new_user()
      returns trigger
      language plpgsql
      security definer as $$
      declare
        v_username text;
      begin
        v_username := coalesce(
          new.raw_user_meta_data->>'username',
          split_part(new.email, '@', 1)
        );
        insert into public.users (id, username) values (new.id, v_username);
        insert into public.profiles (user_id, display_name) values (new.id, v_username);
        return new;
      end;
      $$
    `);
  }
}
