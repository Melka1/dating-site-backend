import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { BlogPost } from './blog-post.entity';
import { BlogTag } from './blog-tag.entity';

@Entity({ name: 'blog_post_tags' })
export class BlogPostTag {
  @PrimaryColumn({ name: 'post_id', type: 'uuid' })
  postId!: string;

  @PrimaryColumn({ name: 'tag_slug', type: 'text' })
  tagSlug!: string;

  @ManyToOne(() => BlogPost, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post?: BlogPost;

  @ManyToOne(() => BlogTag, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tag_slug' })
  tag?: BlogTag;
}
