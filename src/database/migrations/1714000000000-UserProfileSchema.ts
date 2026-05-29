import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserProfileSchema1714000000000 implements MigrationInterface {
  name = 'UserProfileSchema1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create extension if not exists citext`);
    await queryRunner.query(`create extension if not exists pg_trgm`);

    await queryRunner.query(`
      create table public.users (
        id uuid primary key references auth.users(id) on delete cascade,
        username citext unique not null,
        role text not null default 'user'
          check (role in ('user','moderator','admin')),
        account_status text not null default 'active'
          check (account_status in ('active','suspended','banned','deleted')),
        is_online boolean not null default false,
        last_active_at timestamptz,
        onboarding_completed boolean not null default false,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint users_deleted_at_consistency check (
          (account_status = 'deleted') = (deleted_at is not null)
        )
      )
    `);
    await queryRunner.query(`create index users_username_idx on public.users (username)`);
    await queryRunner.query(
      `create index users_last_active_idx on public.users (last_active_at desc)`,
    );
    await queryRunner.query(
      `create index users_account_status_idx on public.users (account_status)`,
    );
    await queryRunner.query(
      `create index users_deleted_at_idx on public.users (deleted_at) where account_status = 'deleted'`,
    );

    await queryRunner.query(`
      create table public.profiles (
        user_id uuid primary key references public.users(id) on delete cascade,

        display_name text not null,
        gender text check (gender in ('male','female','non_binary','other','prefer_not_to_say')),
        seeking text[] not null default '{}',
        dob date,
        marital_status text check (marital_status in ('single','married','divorced','widowed','separated','other')),
        relationship_type text check (relationship_type in ('serious','casual','friendship','affair','marriage','open')),

        country text,
        city text,
        address text,

        bio text,
        looking_for text,
        likes text,

        interests text[] not null default '{}',
        favorite_places text[] not null default '{}',
        languages text[] not null default '{}',
        religion text,
        children text check (children in ('none','have','want','dont_want','maybe')),
        smoking text check (smoking in ('never','casual','regular','trying_to_quit')),
        drinking text check (drinking in ('never','socially','regularly')),

        height_cm int check (height_cm between 100 and 250),
        weight_kg int check (weight_kg between 30 and 300),
        hair_color text,
        eye_color text,
        body_type text,
        ethnicity text,

        profession text,

        avatar_url text,
        cover_url text,

        visibility text not null default 'public'
          check (visibility in ('public','members_only','private')),
        completion_score int not null default 0
          check (completion_score between 0 and 100),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),

        constraint profiles_age_18_plus check (
          dob is null or dob <= current_date - interval '18 years'
        )
      )
    `);
    await queryRunner.query(`create index profiles_gender_idx on public.profiles (gender)`);
    await queryRunner.query(
      `create index profiles_seeking_gin on public.profiles using gin (seeking)`,
    );
    await queryRunner.query(
      `create index profiles_interests_gin on public.profiles using gin (interests)`,
    );
    await queryRunner.query(
      `create index profiles_languages_gin on public.profiles using gin (languages)`,
    );
    await queryRunner.query(`create index profiles_country_idx on public.profiles (country)`);
    await queryRunner.query(
      `create index profiles_profession_idx on public.profiles (profession)`,
    );
    await queryRunner.query(`create index profiles_dob_idx on public.profiles (dob)`);
    await queryRunner.query(
      `create index profiles_display_name_trgm on public.profiles using gin (display_name gin_trgm_ops)`,
    );
    await queryRunner.query(
      `create index profiles_completion_idx on public.profiles (completion_score desc)`,
    );

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
    await queryRunner.query(`
      create trigger on_auth_user_created
        after insert on auth.users
        for each row execute function public.handle_new_user()
    `);

    await queryRunner.query(`
      create or replace function public.touch_updated_at()
      returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end;
      $$
    `);
    await queryRunner.query(`
      create trigger users_touch_updated_at
        before update on public.users
        for each row execute function public.touch_updated_at()
    `);
    await queryRunner.query(`
      create trigger profiles_touch_updated_at
        before update on public.profiles
        for each row execute function public.touch_updated_at()
    `);

    await queryRunner.query(`
      create or replace function public.sync_deleted_at()
      returns trigger language plpgsql as $$
      begin
        if new.account_status = 'deleted' and old.account_status <> 'deleted' then
          new.deleted_at = now();
        elsif new.account_status <> 'deleted' and old.account_status = 'deleted' then
          new.deleted_at = null;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger users_sync_deleted_at
        before update of account_status on public.users
        for each row execute function public.sync_deleted_at()
    `);

    await queryRunner.query(`alter table public.users enable row level security`);
    await queryRunner.query(`alter table public.profiles enable row level security`);

    await queryRunner.query(`
      create policy users_select_active on public.users
        for select using (account_status = 'active')
    `);
    await queryRunner.query(`
      create policy users_select_self on public.users
        for select using (auth.uid() = id)
    `);
    await queryRunner.query(`
      create policy users_update_self on public.users
        for update using (auth.uid() = id)
        with check (auth.uid() = id)
    `);

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
    await queryRunner.query(`
      create policy profiles_update_self on public.profiles
        for update using (user_id = auth.uid())
        with check (user_id = auth.uid())
    `);

    await queryRunner.query(`
      create table public.audit_log (
        id bigserial primary key,
        actor_id uuid references public.users(id) on delete set null,
        target_id uuid references public.users(id) on delete set null,
        action text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`create index audit_log_actor_idx on public.audit_log (actor_id)`);
    await queryRunner.query(`create index audit_log_target_idx on public.audit_log (target_id)`);
    await queryRunner.query(
      `create index audit_log_created_at_idx on public.audit_log (created_at desc)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists public.audit_log`);
    await queryRunner.query(`drop policy if exists profiles_update_self on public.profiles`);
    await queryRunner.query(`drop policy if exists profiles_select on public.profiles`);
    await queryRunner.query(`drop policy if exists users_update_self on public.users`);
    await queryRunner.query(`drop policy if exists users_select_self on public.users`);
    await queryRunner.query(`drop policy if exists users_select_active on public.users`);
    await queryRunner.query(`drop trigger if exists users_sync_deleted_at on public.users`);
    await queryRunner.query(`drop function if exists public.sync_deleted_at()`);
    await queryRunner.query(`drop trigger if exists profiles_touch_updated_at on public.profiles`);
    await queryRunner.query(`drop trigger if exists users_touch_updated_at on public.users`);
    await queryRunner.query(`drop function if exists public.touch_updated_at()`);
    await queryRunner.query(`drop trigger if exists on_auth_user_created on auth.users`);
    await queryRunner.query(`drop function if exists public.handle_new_user()`);
    await queryRunner.query(`drop table if exists public.profiles`);
    await queryRunner.query(`drop table if exists public.users`);
  }
}
