import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { BlogPost } from './blog-post.entity';

@Entity({ name: 'blog_post_likes' })
export class BlogPostLike {
  @PrimaryColumn({ name: 'post_id', type: 'uuid' })
  postId!: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => BlogPost, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post?: BlogPost;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
