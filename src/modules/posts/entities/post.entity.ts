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
import { Group } from '../../groups/entities/group.entity';
import { User } from '../../users/entities/user.entity';
import { Comment } from './comment.entity';
import { PostAttachment } from './post-attachment.entity';
import { PostMention } from './post-mention.entity';
import { Reaction } from './reaction.entity';

export type PostAudience = 'public' | 'friends' | 'private' | 'group';

@Entity({ name: 'posts' })
export class Post {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author?: User;

  @Column({ type: 'text', default: 'public' })
  audience!: PostAudience;

  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId!: string | null;

  @ManyToOne(() => Group, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'group_id' })
  group?: Group | null;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => PostAttachment, (a) => a.post)
  attachments?: PostAttachment[];

  @OneToMany(() => PostMention, (m) => m.post)
  mentions?: PostMention[];

  @OneToMany(() => Reaction, (r) => r.post)
  reactions?: Reaction[];

  @OneToMany(() => Comment, (c) => c.post)
  comments?: Comment[];
}
