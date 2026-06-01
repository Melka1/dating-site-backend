import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum NewsletterStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  UNSUBSCRIBED = 'unsubscribed',
}

export enum NewsletterSource {
  GUEST_FORM = 'guest_form',
  AUTHENTICATED = 'authenticated',
}

@Entity({ name: 'newsletter_subscribers' })
export class NewsletterSubscriber {
  @PrimaryColumn({ type: 'citext' })
  email!: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'text', default: NewsletterStatus.PENDING })
  status!: NewsletterStatus;

  @Column({ type: 'text' })
  source!: NewsletterSource;

  @Column({ name: 'confirmation_sent_at', type: 'timestamptz', nullable: true })
  confirmationSentAt!: Date | null;

  @Column({ name: 'subscribed_at', type: 'timestamptz', nullable: true })
  subscribedAt!: Date | null;

  @Column({ name: 'unsubscribed_at', type: 'timestamptz', nullable: true })
  unsubscribedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
