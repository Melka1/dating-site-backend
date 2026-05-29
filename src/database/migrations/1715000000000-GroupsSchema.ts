import { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupsSchema1715000000000 implements MigrationInterface {
  name = 'GroupsSchema1715000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create extension if not exists pgcrypto`);

    await queryRunner.query(`
      create table public.groups (
        id uuid primary key default gen_random_uuid(),
        slug citext unique not null
          check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),

        name text not null check (char_length(name) between 1 and 80),
        description text check (description is null or char_length(description) <= 2000),
        rules text check (rules is null or char_length(rules) <= 5000),

        owner_id uuid not null references public.users(id) on delete restrict,

        visibility text not null default 'public'
          check (visibility in ('public','unlisted','private')),
        join_policy text not null default 'open'
          check (join_policy in ('open','approval','invite_only')),

        interests text[] not null default '{}',
        country text,
        city text,

        avatar_url text,
        cover_url text,

        max_members int
          check (max_members is null or max_members between 2 and 100000),

        member_count int not null default 0
          check (member_count >= 0),

        admin_suspended_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`create index groups_owner_idx       on public.groups (owner_id)`);
    await queryRunner.query(`create index groups_visibility_idx  on public.groups (visibility)`);
    await queryRunner.query(`create index groups_join_policy_idx on public.groups (join_policy)`);
    await queryRunner.query(`create index groups_country_idx     on public.groups (country)`);
    await queryRunner.query(`create index groups_interests_gin   on public.groups using gin (interests)`);
    await queryRunner.query(`create index groups_name_trgm       on public.groups using gin (name gin_trgm_ops)`);
    await queryRunner.query(
      `create index groups_deleted_at_idx on public.groups (deleted_at) where deleted_at is not null`,
    );

    await queryRunner.query(`
      create table public.group_members (
        group_id uuid not null references public.groups(id) on delete cascade,
        user_id  uuid not null references public.users(id)  on delete cascade,

        role text not null default 'member'
          check (role in ('member','moderator','admin','owner')),
        status text not null default 'active'
          check (status in ('invited','pending','active','banned')),

        invited_by uuid references public.users(id) on delete set null,
        joined_at timestamptz,
        last_seen_at timestamptz,
        banned_until timestamptz,
        ban_reason text,

        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),

        primary key (group_id, user_id),

        constraint group_members_joined_consistency check (
          (status in ('active','banned')) = (joined_at is not null)
        )
      )
    `);
    await queryRunner.query(`create index group_members_group_idx    on public.group_members (group_id)`);
    await queryRunner.query(`create index group_members_user_idx     on public.group_members (user_id)`);
    await queryRunner.query(`create index group_members_status_idx   on public.group_members (group_id, status)`);
    await queryRunner.query(`create index group_members_role_idx     on public.group_members (group_id, role)`);
    await queryRunner.query(`create index group_members_invited_by   on public.group_members (invited_by)`);

    // ---- Triggers ----
    await queryRunner.query(`
      create function public.groups_recount_members()
      returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' and new.status = 'active' then
          update public.groups set member_count = member_count + 1 where id = new.group_id;
        elsif tg_op = 'DELETE' and old.status = 'active' then
          update public.groups set member_count = member_count - 1 where id = old.group_id;
        elsif tg_op = 'UPDATE' and old.status <> new.status then
          if new.status = 'active' then
            update public.groups set member_count = member_count + 1 where id = new.group_id;
          elsif old.status = 'active' then
            update public.groups set member_count = member_count - 1 where id = old.group_id;
          end if;
        end if;
        return coalesce(new, old);
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger group_members_recount
        after insert or update or delete on public.group_members
        for each row execute function public.groups_recount_members()
    `);

    await queryRunner.query(`
      create function public.groups_enforce_single_owner()
      returns trigger language plpgsql as $$
      begin
        if new.role = 'owner' then
          if exists (
            select 1 from public.group_members
             where group_id = new.group_id
               and role = 'owner'
               and user_id <> new.user_id
          ) then
            raise exception 'group % already has an owner', new.group_id;
          end if;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger group_members_single_owner
        before insert or update on public.group_members
        for each row execute function public.groups_enforce_single_owner()
    `);

    await queryRunner.query(`
      create function public.group_members_stamp_joined()
      returns trigger language plpgsql as $$
      begin
        if new.status in ('active','banned') and (old.status is null or old.status not in ('active','banned')) then
          new.joined_at = coalesce(new.joined_at, now());
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger group_members_joined_stamp
        before insert or update of status on public.group_members
        for each row execute function public.group_members_stamp_joined()
    `);

    await queryRunner.query(`
      create function public.groups_seed_owner_membership()
      returns trigger language plpgsql as $$
      begin
        insert into public.group_members (group_id, user_id, role, status, joined_at)
        values (new.id, new.owner_id, 'owner', 'active', now());
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger groups_after_insert_seed_owner
        after insert on public.groups
        for each row execute function public.groups_seed_owner_membership()
    `);

    // touch_updated_at already exists (created in UserProfileSchema migration)
    await queryRunner.query(`
      create trigger groups_touch_updated_at
        before update on public.groups
        for each row execute function public.touch_updated_at()
    `);
    await queryRunner.query(`
      create trigger group_members_touch_updated_at
        before update on public.group_members
        for each row execute function public.touch_updated_at()
    `);

    // ---- RLS ----
    await queryRunner.query(`alter table public.groups enable row level security`);
    await queryRunner.query(`alter table public.group_members enable row level security`);

    await queryRunner.query(`
      create policy groups_select on public.groups
        for select using (
          deleted_at is null
          and (
            visibility = 'public'
            or exists (
              select 1 from public.group_members gm
              where gm.group_id = groups.id
                and gm.user_id  = auth.uid()
                and gm.status   = 'active'
            )
          )
        )
    `);
    await queryRunner.query(`
      create policy groups_insert_self_owner on public.groups
        for insert with check (owner_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy groups_update_owner_or_admin on public.groups
        for update using (
          exists (
            select 1 from public.group_members gm
            where gm.group_id = groups.id
              and gm.user_id  = auth.uid()
              and gm.role     in ('owner','admin')
              and gm.status   = 'active'
          )
        )
        with check (
          exists (
            select 1 from public.group_members gm
            where gm.group_id = groups.id
              and gm.user_id  = auth.uid()
              and gm.role     in ('owner','admin')
              and gm.status   = 'active'
          )
        )
    `);
    await queryRunner.query(`
      create policy groups_delete_owner on public.groups
        for delete using (owner_id = auth.uid())
    `);

    await queryRunner.query(`
      create policy group_members_select on public.group_members
        for select using (
          user_id = auth.uid()
          or exists (
            select 1 from public.group_members gm
            where gm.group_id = group_members.group_id
              and gm.user_id  = auth.uid()
              and gm.status   = 'active'
          )
        )
    `);
    await queryRunner.query(`
      create policy group_members_self_join on public.group_members
        for insert with check (
          user_id = auth.uid()
          and exists (
            select 1 from public.groups g
            where g.id = group_members.group_id
              and g.join_policy = 'open'
              and g.deleted_at is null
          )
        )
    `);
    await queryRunner.query(`
      create policy group_members_update_self on public.group_members
        for update using (user_id = auth.uid())
        with check (user_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy group_members_delete_self on public.group_members
        for delete using (user_id = auth.uid())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop policy if exists group_members_delete_self on public.group_members`);
    await queryRunner.query(`drop policy if exists group_members_update_self on public.group_members`);
    await queryRunner.query(`drop policy if exists group_members_self_join on public.group_members`);
    await queryRunner.query(`drop policy if exists group_members_select on public.group_members`);
    await queryRunner.query(`drop policy if exists groups_delete_owner on public.groups`);
    await queryRunner.query(`drop policy if exists groups_update_owner_or_admin on public.groups`);
    await queryRunner.query(`drop policy if exists groups_insert_self_owner on public.groups`);
    await queryRunner.query(`drop policy if exists groups_select on public.groups`);
    await queryRunner.query(`alter table public.group_members disable row level security`);
    await queryRunner.query(`alter table public.groups disable row level security`);

    await queryRunner.query(`drop trigger if exists group_members_touch_updated_at on public.group_members`);
    await queryRunner.query(`drop trigger if exists groups_touch_updated_at on public.groups`);
    await queryRunner.query(`drop trigger if exists groups_after_insert_seed_owner on public.groups`);
    await queryRunner.query(`drop function if exists public.groups_seed_owner_membership()`);
    await queryRunner.query(`drop trigger if exists group_members_joined_stamp on public.group_members`);
    await queryRunner.query(`drop function if exists public.group_members_stamp_joined()`);
    await queryRunner.query(`drop trigger if exists group_members_single_owner on public.group_members`);
    await queryRunner.query(`drop function if exists public.groups_enforce_single_owner()`);
    await queryRunner.query(`drop trigger if exists group_members_recount on public.group_members`);
    await queryRunner.query(`drop function if exists public.groups_recount_members()`);

    await queryRunner.query(`drop table if exists public.group_members`);
    await queryRunner.query(`drop table if exists public.groups`);
  }
}
