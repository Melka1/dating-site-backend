import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { BlogBlock } from '../blog-blocks';
import { BlogComment } from './blog-comment.entity';

export type BlogPostStatus = 'draft' | 'published' | 'archived';
export type BlogPostType = 'news' | 'story' | 'tips' | 'advice';

@Entity({ name: 'blog_posts' })
export class BlogPost {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_id' })
  author?: User;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  excerpt!: string;

  @Column({ type: 'text', default: 'news' })
  type!: BlogPostType;

  @Column({ type: 'jsonb', nullable: true })
  body!: BlogBlock[] | null;

  @Column({ name: 'cover_image_url', type: 'text', nullable: true })
  coverImageUrl!: string | null;

  @Column({ name: 'cover_video_url', type: 'text', nullable: true })
  coverVideoUrl!: string | null;

  @Column({ type: 'text', default: 'draft' })
  status!: BlogPostStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => BlogComment, (c) => c.post)
  comments?: BlogComment[];
}
