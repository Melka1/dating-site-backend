import { MigrationInterface, QueryRunner } from 'typeorm';

export class PostsSchema1717000000000 implements MigrationInterface {
  name = 'PostsSchema1717000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- posts ----
    await queryRunner.query(`
      create table public.posts (
        id uuid primary key default gen_random_uuid(),
        author_id uuid not null references public.users(id) on delete cascade,

        audience text not null default 'public'
          check (audience in ('public','friends','private','group')),
        group_id uuid references public.groups(id) on delete cascade,

        body text,

        edited_at  timestamptz,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),

        constraint posts_body_required check (deleted_at is not null or body is not null),
        constraint posts_body_length   check (body is null or char_length(body) between 1 and 5000),
        constraint posts_group_consistency check (
          (audience = 'group') = (group_id is not null)
        )
      )
    `);
    await queryRunner.query(
      `create index posts_author_created_idx on public.posts (author_id, created_at desc) where deleted_at is null`,
    );
    await queryRunner.query(
      `create index posts_group_created_idx on public.posts (group_id, created_at desc) where audience = 'group' and deleted_at is null`,
    );
    await queryRunner.query(
      `create index posts_public_created_idx on public.posts (created_at desc) where audience = 'public' and deleted_at is null`,
    );
    await queryRunner.query(
      `create index posts_deleted_at_idx on public.posts (deleted_at) where deleted_at is not null`,
    );

    // ---- post_attachments ----
    // No Media model in this codebase yet; attachments carry URL/dims inline.
    await queryRunner.query(`
      create table public.post_attachments (
        id uuid primary key default gen_random_uuid(),
        post_id uuid not null references public.posts(id) on delete cascade,
        kind text not null check (kind in ('photo','video')),
        url text not null,
        thumbnail_url text,
        width  int check (width  is null or width  between 1 and 10000),
        height int check (height is null or height between 1 and 10000),
        display_order int not null default 0,
        created_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create index post_attachments_post_idx on public.post_attachments (post_id, display_order)`,
    );

    // ---- post_mentions ----
    await queryRunner.query(`
      create table public.post_mentions (
        post_id uuid not null references public.posts(id) on delete cascade,
        user_id uuid not null references public.users(id) on delete cascade,
        primary key (post_id, user_id)
      )
    `);
    await queryRunner.query(
      `create index post_mentions_user_idx on public.post_mentions (user_id, post_id)`,
    );

    // ---- reactions ----
    await queryRunner.query(`
      create table public.reactions (
        post_id uuid not null references public.posts(id) on delete cascade,
        user_id uuid not null references public.users(id) on delete cascade,
        type text not null
          check (type in ('like','heart','laugh','wow','sad','angry')),
        created_at timestamptz not null default now(),
        primary key (post_id, user_id)
      )
    `);
    await queryRunner.query(
      `create index reactions_post_type_idx on public.reactions (post_id, type)`,
    );
    await queryRunner.query(
      `create index reactions_user_idx on public.reactions (user_id, created_at desc)`,
    );

    // ---- comments ----
    await queryRunner.query(`
      create table public.comments (
        id uuid primary key default gen_random_uuid(),
        post_id  uuid not null references public.posts(id)    on delete cascade,
        parent_id uuid references public.comments(id)         on delete cascade,
        author_id uuid not null references public.users(id)   on delete cascade,

        body text,
        edited_at  timestamptz,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),

        constraint comments_body_required check (deleted_at is not null or body is not null),
        constraint comments_body_length   check (body is null or char_length(body) between 1 and 2000)
      )
    `);
    await queryRunner.query(
      `create index comments_post_created_idx on public.comments (post_id, created_at) where deleted_at is null`,
    );
    await queryRunner.query(
      `create index comments_parent_idx on public.comments (parent_id) where parent_id is not null`,
    );
    await queryRunner.query(
      `create index comments_author_idx on public.comments (author_id, created_at desc) where deleted_at is null`,
    );

    // ---- post_favorites ----
    await queryRunner.query(`
      create table public.post_favorites (
        user_id uuid not null references public.users(id) on delete cascade,
        post_id uuid not null references public.posts(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (user_id, post_id)
      )
    `);
    await queryRunner.query(
      `create index post_favorites_user_idx on public.post_favorites (user_id, created_at desc)`,
    );
    await queryRunner.query(
      `create index post_favorites_post_idx on public.post_favorites (post_id)`,
    );

    // ---- touch_updated_at triggers (function defined in UserProfileSchema) ----
    await queryRunner.query(`
      create trigger posts_touch_updated_at
        before update on public.posts
        for each row execute function public.touch_updated_at()
    `);
    await queryRunner.query(`
      create trigger comments_touch_updated_at
        before update on public.comments
        for each row execute function public.touch_updated_at()
    `);

    // ---- RLS ----
    await queryRunner.query(`alter table public.posts            enable row level security`);
    await queryRunner.query(`alter table public.post_attachments enable row level security`);
    await queryRunner.query(`alter table public.post_mentions    enable row level security`);
    await queryRunner.query(`alter table public.reactions        enable row level security`);
    await queryRunner.query(`alter table public.comments         enable row level security`);
    await queryRunner.query(`alter table public.post_favorites   enable row level security`);

    // posts: author can always read own (incl. deleted/private).
    await queryRunner.query(`
      create policy posts_select_author on public.posts
        for select using (author_id = auth.uid())
    `);

    // posts: visibility to others by audience.
    // Friendship table in this codebase uses user_low/user_high (sorted pair).
    await queryRunner.query(`
      create policy posts_select_visible on public.posts
        for select using (
          deleted_at is null
          and (
            audience = 'public'
            or (
              audience = 'group'
              and exists (
                select 1 from public.group_members gm
                 where gm.group_id = posts.group_id
                   and gm.user_id  = auth.uid()
                   and gm.status   = 'active'
              )
            )
            or (
              audience = 'friends'
              and exists (
                select 1 from public.friendships f
                 where f.status = 'accepted'
                   and ((f.user_low  = posts.author_id and f.user_high = auth.uid())
                     or (f.user_high = posts.author_id and f.user_low  = auth.uid()))
              )
            )
          )
          and not exists (
            select 1 from public.user_blocks b
             where (b.blocker_id = posts.author_id and b.blocked_id = auth.uid())
                or (b.blocker_id = auth.uid()      and b.blocked_id = posts.author_id)
          )
        )
    `);

    await queryRunner.query(`
      create policy posts_write_self on public.posts
        for all using (author_id = auth.uid()) with check (author_id = auth.uid())
    `);

    // post_attachments — gated through parent post visibility (via EXISTS).
    await queryRunner.query(`
      create policy post_attachments_select on public.post_attachments
        for select using (
          exists (select 1 from public.posts p where p.id = post_id)
        )
    `);
    await queryRunner.query(`
      create policy post_attachments_write_self on public.post_attachments
        for all using (
          exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
        ) with check (
          exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
        )
    `);

    // post_mentions — read gated by post visibility, writes by backend only.
    await queryRunner.query(`
      create policy post_mentions_select on public.post_mentions
        for select using (
          exists (select 1 from public.posts p where p.id = post_id)
        )
    `);

    // reactions
    await queryRunner.query(`
      create policy reactions_select on public.reactions
        for select using (
          exists (select 1 from public.posts p where p.id = post_id)
        )
    `);
    await queryRunner.query(`
      create policy reactions_write_self on public.reactions
        for all using (user_id = auth.uid()) with check (user_id = auth.uid())
    `);

    // comments
    await queryRunner.query(`
      create policy comments_select on public.comments
        for select using (
          deleted_at is null
          and exists (select 1 from public.posts p where p.id = post_id)
        )
    `);
    await queryRunner.query(`
      create policy comments_select_author on public.comments
        for select using (author_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy comments_write_self on public.comments
        for all using (author_id = auth.uid()) with check (author_id = auth.uid())
    `);

    // post_favorites — private to the user.
    await queryRunner.query(`
      create policy post_favorites_select_self on public.post_favorites
        for select using (user_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy post_favorites_write_self on public.post_favorites
        for all using (user_id = auth.uid()) with check (user_id = auth.uid())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop policy if exists post_favorites_write_self on public.post_favorites`);
    await queryRunner.query(`drop policy if exists post_favorites_select_self on public.post_favorites`);
    await queryRunner.query(`drop policy if exists comments_write_self on public.comments`);
    await queryRunner.query(`drop policy if exists comments_select_author on public.comments`);
    await queryRunner.query(`drop policy if exists comments_select on public.comments`);
    await queryRunner.query(`drop policy if exists reactions_write_self on public.reactions`);
    await queryRunner.query(`drop policy if exists reactions_select on public.reactions`);
    await queryRunner.query(`drop policy if exists post_mentions_select on public.post_mentions`);
    await queryRunner.query(`drop policy if exists post_attachments_write_self on public.post_attachments`);
    await queryRunner.query(`drop policy if exists post_attachments_select on public.post_attachments`);
    await queryRunner.query(`drop policy if exists posts_write_self on public.posts`);
    await queryRunner.query(`drop policy if exists posts_select_visible on public.posts`);
    await queryRunner.query(`drop policy if exists posts_select_author on public.posts`);

    await queryRunner.query(`alter table public.post_favorites   disable row level security`);
    await queryRunner.query(`alter table public.comments         disable row level security`);
    await queryRunner.query(`alter table public.reactions        disable row level security`);
    await queryRunner.query(`alter table public.post_mentions    disable row level security`);
    await queryRunner.query(`alter table public.post_attachments disable row level security`);
    await queryRunner.query(`alter table public.posts            disable row level security`);

    await queryRunner.query(`drop trigger if exists comments_touch_updated_at on public.comments`);
    await queryRunner.query(`drop trigger if exists posts_touch_updated_at on public.posts`);

    await queryRunner.query(`drop table if exists public.post_favorites`);
    await queryRunner.query(`drop table if exists public.comments`);
    await queryRunner.query(`drop table if exists public.reactions`);
    await queryRunner.query(`drop table if exists public.post_mentions`);
    await queryRunner.query(`drop table if exists public.post_attachments`);
    await queryRunner.query(`drop table if exists public.posts`);
  }
}
