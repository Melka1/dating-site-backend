import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Blog body redesign — see the design note at the top of
 * docs/blog-implementation-progress.md.
 *
 * Morphs the v1 schema (1719) into the v2 shape:
 *   - `body` text → `body` jsonb (array of typed content blocks).
 *     Pre-existing text bodies are wrapped as a single `paragraph` block.
 *   - `format` enum gone (gallery → image block; video → cover_video_url;
 *     code → future block type).
 *   - `video_url` renamed to `cover_video_url` (covers can now be image OR
 *     video at the same slot).
 *   - `code_snippet` column dropped.
 *   - `blog_post_media` join table dropped (gallery images live inside the
 *     body JSON now).
 *   - New CHECKs: body must be a JSON array; cover_image_url XOR
 *     cover_video_url; publish requires at least one cover.
 */
export class BlogContentBlocks1720000000000 implements MigrationInterface {
  name = 'BlogContentBlocks1720000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop constraints that reference columns we're about to remove or
    //    that wouldn't typecheck after `body` becomes jsonb.
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_body_length`,
    );
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_video_consistency`,
    );
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_code_consistency`,
    );
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_published_has_cover`,
    );

    // 2. Drop the format index (column going away).
    await queryRunner.query(`drop index if exists public.blog_posts_format_idx`);

    // 3. Convert body text → jsonb. Wrap any existing text content as a
    //    single paragraph block so we don't lose data. (Likely no rows
    //    exist yet, but the cast is non-destructive either way.)
    await queryRunner.query(`
      alter table public.blog_posts
        alter column body type jsonb
        using case
          when body is null then null
          else jsonb_build_array(
            jsonb_build_object('type', 'paragraph', 'text', body)
          )
        end
    `);

    // 4. Rename video_url → cover_video_url.
    await queryRunner.query(
      `alter table public.blog_posts rename column video_url to cover_video_url`,
    );

    // 5. Drop format and code_snippet columns.
    await queryRunner.query(`alter table public.blog_posts drop column format`);
    await queryRunner.query(`alter table public.blog_posts drop column code_snippet`);

    // 6. Add the new CHECKs.
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_body_is_array
        check (body is null or jsonb_typeof(body) = 'array')
    `);
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_cover_xor
        check (cover_image_url is null or cover_video_url is null)
    `);
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_published_has_cover
        check (
          status <> 'published'
          or cover_image_url is not null
          or cover_video_url is not null
        )
    `);

    // 7. Drop blog_post_media table — gallery images now live inside the
    //    body JSON. Policies first, then the table.
    await queryRunner.query(
      `drop policy if exists blog_post_media_write_editor on public.blog_post_media`,
    );
    await queryRunner.query(
      `drop policy if exists blog_post_media_select on public.blog_post_media`,
    );
    await queryRunner.query(`drop table if exists public.blog_post_media`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Recreate blog_post_media table + index + RLS.
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
    await queryRunner.query(
      `alter table public.blog_post_media enable row level security`,
    );
    await queryRunner.query(`
      create policy blog_post_media_select on public.blog_post_media
        for select using (exists (select 1 from public.blog_posts p where p.id = post_id))
    `);
    await queryRunner.query(`
      create policy blog_post_media_write_editor on public.blog_post_media
        for all using (public.is_editor()) with check (public.is_editor())
    `);

    // 2. Drop new constraints.
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_published_has_cover`,
    );
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_cover_xor`,
    );
    await queryRunner.query(
      `alter table public.blog_posts drop constraint if exists blog_posts_body_is_array`,
    );

    // 3. Re-add format and code_snippet columns.
    await queryRunner.query(`
      alter table public.blog_posts add column format text not null default 'standard'
        check (format in ('standard','gallery','video','code'))
    `);
    await queryRunner.query(`alter table public.blog_posts add column code_snippet text`);

    // 4. Rename cover_video_url back to video_url.
    await queryRunner.query(
      `alter table public.blog_posts rename column cover_video_url to video_url`,
    );

    // 5. Convert body back to text. Lossy: only the first paragraph block's
    //    text survives. Real recovery would need an out-of-band backup.
    await queryRunner.query(`
      alter table public.blog_posts
        alter column body type text
        using case
          when body is null then null
          when jsonb_typeof(body) = 'array' and jsonb_array_length(body) > 0
            then body->0->>'text'
          else null
        end
    `);

    // 6. Restore the old constraints.
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_body_length
        check (body is null or char_length(body) between 1 and 200000)
    `);
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_video_consistency
        check ((format = 'video') = (video_url is not null))
    `);
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_code_consistency
        check ((format = 'code') = (code_snippet is not null))
    `);
    await queryRunner.query(`
      alter table public.blog_posts
        add constraint blog_posts_published_has_cover
        check (status <> 'published' or cover_image_url is not null)
    `);

    // 7. Restore the format index.
    await queryRunner.query(
      `create index blog_posts_format_idx on public.blog_posts (format, published_at desc) where status = 'published' and deleted_at is null`,
    );
  }
}
