import { MigrationInterface, QueryRunner } from 'typeorm';

export class FriendsSchema1716000000000 implements MigrationInterface {
  name = 'FriendsSchema1716000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- users.friend_count denormalised counter ----
    await queryRunner.query(`
      alter table public.users
        add column if not exists friend_count int not null default 0
          check (friend_count >= 0)
    `);
    await queryRunner.query(
      `create index if not exists users_friend_count_idx on public.users (friend_count desc)`,
    );

    // ---- friendships ----
    await queryRunner.query(`
      create table public.friendships (
        user_low  uuid not null references public.users(id) on delete cascade,
        user_high uuid not null references public.users(id) on delete cascade,

        requested_by uuid not null references public.users(id) on delete cascade,

        status text not null default 'pending'
          check (status in ('pending','accepted')),

        message text check (message is null or char_length(message) <= 280),

        accepted_at timestamptz,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),

        primary key (user_low, user_high),

        constraint friendships_sorted check (user_low < user_high),
        constraint friendships_self_forbidden check (user_low <> user_high),
        constraint friendships_requested_by_is_pair check (
          requested_by = user_low or requested_by = user_high
        ),
        constraint friendships_accepted_consistency check (
          (status = 'accepted') = (accepted_at is not null)
        )
      )
    `);
    await queryRunner.query(
      `create index friendships_user_low_idx     on public.friendships (user_low)`,
    );
    await queryRunner.query(
      `create index friendships_user_high_idx    on public.friendships (user_high)`,
    );
    await queryRunner.query(
      `create index friendships_status_idx       on public.friendships (status)`,
    );
    await queryRunner.query(
      `create index friendships_requested_by_idx on public.friendships (requested_by)`,
    );
    await queryRunner.query(
      `create index friendships_accepted_at_idx  on public.friendships (accepted_at desc) where status = 'accepted'`,
    );

    // ---- user_blocks ----
    await queryRunner.query(`
      create table public.user_blocks (
        blocker_id uuid not null references public.users(id) on delete cascade,
        blocked_id uuid not null references public.users(id) on delete cascade,

        reason text check (reason is null or char_length(reason) <= 280),
        created_at timestamptz not null default now(),

        primary key (blocker_id, blocked_id),

        constraint user_blocks_self_forbidden check (blocker_id <> blocked_id)
      )
    `);
    await queryRunner.query(
      `create index user_blocks_blocker_idx on public.user_blocks (blocker_id)`,
    );
    await queryRunner.query(
      `create index user_blocks_blocked_idx on public.user_blocks (blocked_id)`,
    );

    // ---- Triggers ----
    await queryRunner.query(`
      create function public.friendships_recount()
      returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' and new.status = 'accepted' then
          update public.users set friend_count = friend_count + 1
            where id in (new.user_low, new.user_high);
        elsif tg_op = 'DELETE' and old.status = 'accepted' then
          update public.users set friend_count = greatest(friend_count - 1, 0)
            where id in (old.user_low, old.user_high);
        elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
          if new.status = 'accepted' then
            update public.users set friend_count = friend_count + 1
              where id in (new.user_low, new.user_high);
          elsif old.status = 'accepted' then
            update public.users set friend_count = greatest(friend_count - 1, 0)
              where id in (old.user_low, old.user_high);
          end if;
        end if;
        return coalesce(new, old);
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger friendships_recount
        after insert or update or delete on public.friendships
        for each row execute function public.friendships_recount()
    `);

    await queryRunner.query(`
      create function public.friendships_stamp_accepted()
      returns trigger language plpgsql as $$
      begin
        if new.status = 'accepted' and (old.status is distinct from 'accepted') then
          new.accepted_at = coalesce(new.accepted_at, now());
        elsif new.status <> 'accepted' then
          new.accepted_at = null;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger friendships_accepted_stamp
        before update of status on public.friendships
        for each row execute function public.friendships_stamp_accepted()
    `);

    // touch_updated_at already exists (UserProfileSchema migration).
    await queryRunner.query(`
      create trigger friendships_touch_updated_at
        before update on public.friendships
        for each row execute function public.touch_updated_at()
    `);

    // ---- RLS ----
    await queryRunner.query(`alter table public.friendships enable row level security`);
    await queryRunner.query(`alter table public.user_blocks enable row level security`);

    await queryRunner.query(`
      create policy friendships_select_self on public.friendships
        for select using (
          auth.uid() = user_low or auth.uid() = user_high
        )
    `);
    await queryRunner.query(`
      create policy friendships_insert_self on public.friendships
        for insert with check (
          status = 'pending'
          and requested_by = auth.uid()
          and (auth.uid() = user_low or auth.uid() = user_high)
          and not exists (
            select 1 from public.user_blocks b
            where (b.blocker_id = user_low  and b.blocked_id = user_high)
               or (b.blocker_id = user_high and b.blocked_id = user_low)
          )
        )
    `);
    await queryRunner.query(`
      create policy friendships_update_accept on public.friendships
        for update using (
          (auth.uid() = user_low or auth.uid() = user_high)
          and auth.uid() <> requested_by
          and status = 'pending'
        )
        with check (
          status = 'accepted'
          and (auth.uid() = user_low or auth.uid() = user_high)
        )
    `);
    await queryRunner.query(`
      create policy friendships_delete_self on public.friendships
        for delete using (
          auth.uid() = user_low or auth.uid() = user_high
        )
    `);

    await queryRunner.query(`
      create policy user_blocks_select_owner on public.user_blocks
        for select using (blocker_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy user_blocks_insert_owner on public.user_blocks
        for insert with check (blocker_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy user_blocks_delete_owner on public.user_blocks
        for delete using (blocker_id = auth.uid())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop policy if exists user_blocks_delete_owner on public.user_blocks`);
    await queryRunner.query(`drop policy if exists user_blocks_insert_owner on public.user_blocks`);
    await queryRunner.query(`drop policy if exists user_blocks_select_owner on public.user_blocks`);

    await queryRunner.query(`drop policy if exists friendships_delete_self on public.friendships`);
    await queryRunner.query(`drop policy if exists friendships_update_accept on public.friendships`);
    await queryRunner.query(`drop policy if exists friendships_insert_self on public.friendships`);
    await queryRunner.query(`drop policy if exists friendships_select_self on public.friendships`);

    await queryRunner.query(`alter table public.user_blocks disable row level security`);
    await queryRunner.query(`alter table public.friendships disable row level security`);

    await queryRunner.query(`drop trigger if exists friendships_touch_updated_at on public.friendships`);
    await queryRunner.query(`drop trigger if exists friendships_accepted_stamp on public.friendships`);
    await queryRunner.query(`drop function if exists public.friendships_stamp_accepted()`);
    await queryRunner.query(`drop trigger if exists friendships_recount on public.friendships`);
    await queryRunner.query(`drop function if exists public.friendships_recount()`);

    await queryRunner.query(`drop table if exists public.user_blocks`);
    await queryRunner.query(`drop table if exists public.friendships`);

    await queryRunner.query(`drop index if exists users_friend_count_idx`);
    await queryRunner.query(`alter table public.users drop column if exists friend_count`);
  }
}
