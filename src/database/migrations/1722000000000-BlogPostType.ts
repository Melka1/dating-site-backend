import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a `type` taxonomy to blog posts (news / story / tips / advice).
 * Backfills existing rows to 'news' and indexes the column on the
 * published feed since the list endpoint exposes it as a filter.
 */
export class BlogPostType1722000000000 implements MigrationInterface {
  name = 'BlogPostType1722000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table public.blog_posts
        add column type text not null default 'news'
        check (type in ('news','story','tips','advice'))
    `);
    await queryRunner.query(
      `create index blog_posts_type_idx on public.blog_posts (type, published_at desc) where status = 'published' and deleted_at is null`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists public.blog_posts_type_idx`);
    await queryRunner.query(`alter table public.blog_posts drop column type`);
  }
}
