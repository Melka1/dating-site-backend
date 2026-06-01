import { MigrationInterface, QueryRunner } from 'typeorm';

export class NewsletterSubscribers1724000000000 implements MigrationInterface {
  name = 'NewsletterSubscribers1724000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table public.newsletter_subscribers (
        email citext primary key,
        user_id uuid null references public.users(id) on delete set null,
        status text not null default 'pending',
        source text not null,
        confirmation_sent_at timestamptz null,
        subscribed_at timestamptz null,
        unsubscribed_at timestamptz null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint newsletter_subscribers_status_check
          check (status in ('pending', 'active', 'unsubscribed'))
      )
    `);
    await queryRunner.query(
      `create index newsletter_subscribers_user_id_idx on public.newsletter_subscribers (user_id) where user_id is not null`,
    );
    await queryRunner.query(
      `create index newsletter_subscribers_status_idx on public.newsletter_subscribers (status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists public.newsletter_subscribers`);
  }
}
