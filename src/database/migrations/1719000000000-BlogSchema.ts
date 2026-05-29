import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial blog schema — see docs/posts.md (BlogPost + BlogComment + Tag model).
 *
 * This was the first cut of the blog tables. The shape evolved in
 * 1720000000000-BlogContentBlocks: body became a `jsonb` array of typed
 * content blocks, the `format` enum was retired (gallery → an image block,
 * video → cover_video_url, code → future block type), and `blog_post_media`
 * was dropped. Migrations are append-only history — DON'T edit this file
 * even if you wish you had; add another migration.
 */
export class BlogSchema1719000000000 implements MigrationInterface {
  name = 'BlogSchema1719000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- is_editor() helper ----
    // True iff auth.uid()'s users.role IN ('moderator','admin'). Used by
    // every blog write policy; cheap because users.role is on the indexed PK.
    await queryRunner.query(`
      create or replace function public.is_editor()
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $$
        select exists (
          select 1 from public.users u
          where u.id = auth.uid()
            and u.role in ('moderator','admin')
        )
      $$
    `);

    // ---- blog_tags ----
    await queryRunner.query(`
      create table public.blog_tags (
        slug        text primary key,
        name        text not null,
        created_at  timestamptz not null default now(),
        constraint blog_tags_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        constraint blog_tags_name_length check (char_length(name) between 1 and 60)
      )
    `);

    // ---- blog_posts ----
    await queryRunner.query(`
      create table public.blog_posts (
        id                uuid primary key default gen_random_uuid(),
        slug              text unique not null,
        author_id         uuid not null references public.users(id) on delete restrict,

        title             text not null,
        excerpt           text not null,
        body              text,

        format            text not null default 'standard'
          check (format in ('standard','gallery','video','code')),
        cover_image_url   text,
        video_url         text,
        code_snippet      text,

        status            text not null default 'draft'
          check (status in ('draft','published','archived')),
        published_at      timestamptz,

        edited_at         timestamptz,
        deleted_at        timestamptz,
        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now(),

        constraint blog_posts_slug_format    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        constraint blog_posts_title_length   check (char_length(title) between 1 and 200),
        constraint blog_posts_excerpt_length check (char_length(excerpt) between 1 and 500),
        constraint blog_posts_body_required  check (deleted_at is not null or body is not null),
        constraint blog_posts_body_length    check (body is null or char_length(body) between 1 and 200000),

        constraint blog_posts_published_has_date check (
          (status = 'published') = (published_at is not null)
        ),
        constraint blog_posts_published_has_cover check (
          status <> 'published' or cover_image_url is not null
        ),
        constraint blog_posts_video_consistency check (
          (format = 'video') = (video_url is not null)
        ),
        constraint blog_posts_code_consistency check (
          (format = 'code') = (code_snippet is not null)
        )
      )
    `);
    await queryRunner.query(
      `create index blog_posts_published_idx on public.blog_posts (published_at desc) where status = 'published' and deleted_at is null`,
    );
    await queryRunner.query(
      `create index blog_posts_author_idx on public.blog_posts (author_id, created_at desc) where deleted_at is null`,
    );
    await queryRunner.query(
      `create index blog_posts_format_idx on public.blog_posts (format, published_at desc) where status = 'published' and deleted_at is null`,
    );
    await queryRunner.query(
      `create index blog_posts_deleted_at_idx on public.blog_posts (deleted_at) where deleted_at is not null`,
    );

    // ---- blog_post_media (gallery format) ----
    // URL-inline (no shared Media model in this codebase yet).
    await queryRunner.query(`
      create table public.blog_post_media (
        id              uuid primary key default gen_random_uuid(),
        post_id         uuid not null references public.blog_posts(id) on delete cascade,
        url             text not null,
        thumbnail_url   text,
        width           int check (width  is null or width  between 1 and 10000),
        height          int check (height is null or height between 1 and 10000),
        display_order   int not null default 0,
        created_at      timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create index blog_post_media_post_idx on public.blog_post_media (post_id, display_order)`,
    );

    // ---- blog_post_tags ----
    await queryRunner.query(`
      create table public.blog_post_tags (
        post_id   uuid not null references public.blog_posts(id) on delete cascade,
        tag_slug  text not null references public.blog_tags(slug) on delete cascade,
        primary key (post_id, tag_slug)
      )
    `);
    await queryRunner.query(
      `create index blog_post_tags_tag_idx on public.blog_post_tags (tag_slug)`,
    );

    // ---- blog_post_likes ----
    await queryRunner.query(`
      create table public.blog_post_likes (
        post_id     uuid not null references public.blog_posts(id) on delete cascade,
        user_id     uuid not null references public.users(id)      on delete cascade,
        created_at  timestamptz not null default now(),
        primary key (post_id, user_id)
      )
    `);
    await queryRunner.query(
      `create index blog_post_likes_user_idx on public.blog_post_likes (user_id, created_at desc)`,
    );

    // ---- blog_comments ----
    await queryRunner.query(`
      create table public.blog_comments (
        id          uuid primary key default gen_random_uuid(),
        post_id     uuid not null references public.blog_posts(id) on delete cascade,
        parent_id   uuid references public.blog_comments(id)        on delete cascade,
        author_id   uuid not null references public.users(id)       on delete cascade,

        body        text,
        edited_at   timestamptz,
        deleted_at  timestamptz,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),

        constraint blog_comments_body_required check (deleted_at is not null or body is not null),
        constraint blog_comments_body_length   check (body is null or char_length(body) between 1 and 2000)
      )
    `);
    await queryRunner.query(
      `create index blog_comments_post_created_idx on public.blog_comments (post_id, created_at) where deleted_at is null`,
    );
    await queryRunner.query(
      `create index blog_comments_parent_idx on public.blog_comments (parent_id) where parent_id is not null`,
    );
    await queryRunner.query(
      `create index blog_comments_author_idx on public.blog_comments (author_id, created_at desc) where deleted_at is null`,
    );

    // ---- touch_updated_at triggers ----
    await queryRunner.query(`
      create trigger blog_posts_touch_updated_at
        before update on public.blog_posts
        for each row execute function public.touch_updated_at()
    `);
    await queryRunner.query(`
      create trigger blog_comments_touch_updated_at
        before update on public.blog_comments
        for each row execute function public.touch_updated_at()
    `);

    // ---- RLS ----
    await queryRunner.query(`alter table public.blog_posts      enable row level security`);
    await queryRunner.query(`alter table public.blog_post_media enable row level security`);
    await queryRunner.query(`alter table public.blog_post_tags  enable row level security`);
    await queryRunner.query(`alter table public.blog_tags       enable row level security`);
    await queryRunner.query(`alter table public.blog_post_likes enable row level security`);
    await queryRunner.query(`alter table public.blog_comments   enable row level security`);

    // blog_posts: published posts world-readable.
    await queryRunner.query(`
      create policy blog_posts_select_published on public.blog_posts
        for select using (status = 'published' and deleted_at is null)
    `);
    // Authors and editors see their own/all (incl. drafts + deleted).
    await queryRunner.query(`
      create policy blog_posts_select_author on public.blog_posts
        for select using (author_id = auth.uid() or public.is_editor())
    `);
    // Only editors can write — RLS belt-and-braces with controller guard.
    await queryRunner.query(`
      create policy blog_posts_write_editor on public.blog_posts
        for all using (public.is_editor())
        with check (public.is_editor() and author_id = auth.uid())
    `);

    // blog_post_media: visible iff parent post is visible.
    await queryRunner.query(`
      create policy blog_post_media_select on public.blog_post_media
        for select using (exists (select 1 from public.blog_posts p where p.id = post_id))
    `);
    await queryRunner.query(`
      create policy blog_post_media_write_editor on public.blog_post_media
        for all using (public.is_editor()) with check (public.is_editor())
    `);

    // blog_post_tags
    await queryRunner.query(`
      create policy blog_post_tags_select on public.blog_post_tags
        for select using (exists (select 1 from public.blog_posts p where p.id = post_id))
    `);
    await queryRunner.query(`
      create policy blog_post_tags_write_editor on public.blog_post_tags
        for all using (public.is_editor()) with check (public.is_editor())
    `);

    // blog_tags
    await queryRunner.query(`
      create policy blog_tags_select_all on public.blog_tags
        for select using (true)
    `);
    await queryRunner.query(`
      create policy blog_tags_write_editor on public.blog_tags
        for all using (public.is_editor()) with check (public.is_editor())
    `);

    // blog_post_likes
    await queryRunner.query(`
      create policy blog_post_likes_select on public.blog_post_likes
        for select using (exists (select 1 from public.blog_posts p where p.id = post_id))
    `);
    await queryRunner.query(`
      create policy blog_post_likes_write_self on public.blog_post_likes
        for all using (user_id = auth.uid()) with check (user_id = auth.uid())
    `);

    // blog_comments
    await queryRunner.query(`
      create policy blog_comments_select on public.blog_comments
        for select using (
          deleted_at is null
          and exists (
            select 1 from public.blog_posts p
            where p.id = post_id and p.status = 'published' and p.deleted_at is null
          )
        )
    `);
    await queryRunner.query(`
      create policy blog_comments_select_author on public.blog_comments
        for select using (author_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy blog_comments_write_self on public.blog_comments
        for all using (author_id = auth.uid()) with check (author_id = auth.uid())
    `);
    await queryRunner.query(`
      create policy blog_comments_moderate on public.blog_comments
        for update using (public.is_editor()) with check (public.is_editor())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop policy if exists blog_comments_moderate on public.blog_comments`);
    await queryRunner.query(`drop policy if exists blog_comments_write_self on public.blog_comments`);
    await queryRunner.query(`drop policy if exists blog_comments_select_author on public.blog_comments`);
    await queryRunner.query(`drop policy if exists blog_comments_select on public.blog_comments`);
    await queryRunner.query(`drop policy if exists blog_post_likes_write_self on public.blog_post_likes`);
    await queryRunner.query(`drop policy if exists blog_post_likes_select on public.blog_post_likes`);
    await queryRunner.query(`drop policy if exists blog_tags_write_editor on public.blog_tags`);
    await queryRunner.query(`drop policy if exists blog_tags_select_all on public.blog_tags`);
    await queryRunner.query(`drop policy if exists blog_post_tags_write_editor on public.blog_post_tags`);
    await queryRunner.query(`drop policy if exists blog_post_tags_select on public.blog_post_tags`);
    await queryRunner.query(`drop policy if exists blog_post_media_write_editor on public.blog_post_media`);
    await queryRunner.query(`drop policy if exists blog_post_media_select on public.blog_post_media`);
    await queryRunner.query(`drop policy if exists blog_posts_write_editor on public.blog_posts`);
    await queryRunner.query(`drop policy if exists blog_posts_select_author on public.blog_posts`);
    await queryRunner.query(`drop policy if exists blog_posts_select_published on public.blog_posts`);

    await queryRunner.query(`alter table public.blog_comments   disable row level security`);
    await queryRunner.query(`alter table public.blog_post_likes disable row level security`);
    await queryRunner.query(`alter table public.blog_tags       disable row level security`);
    await queryRunner.query(`alter table public.blog_post_tags  disable row level security`);
    await queryRunner.query(`alter table public.blog_post_media disable row level security`);
    await queryRunner.query(`alter table public.blog_posts      disable row level security`);

    await queryRunner.query(`drop trigger if exists blog_comments_touch_updated_at on public.blog_comments`);
    await queryRunner.query(`drop trigger if exists blog_posts_touch_updated_at on public.blog_posts`);

    await queryRunner.query(`drop table if exists public.blog_comments`);
    await queryRunner.query(`drop table if exists public.blog_post_likes`);
    await queryRunner.query(`drop table if exists public.blog_post_tags`);
    await queryRunner.query(`drop table if exists public.blog_post_media`);
    await queryRunner.query(`drop table if exists public.blog_posts`);
    await queryRunner.query(`drop table if exists public.blog_tags`);

    await queryRunner.query(`drop function if exists public.is_editor()`);
  }
}
