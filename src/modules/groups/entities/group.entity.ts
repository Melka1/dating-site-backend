import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { GroupMember } from './group-member.entity';

export type GroupVisibility = 'public' | 'unlisted' | 'private';
export type GroupJoinPolicy = 'open' | 'approval' | 'invite_only';

@Entity({ name: 'groups' })
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'citext' })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  rules!: string | null;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner?: User;

  @Column({ type: 'text', default: 'public' })
  visibility!: GroupVisibility;

  @Column({ name: 'join_policy', type: 'text', default: 'open' })
  joinPolicy!: GroupJoinPolicy;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  interests!: string[];

  @Column({ type: 'text', nullable: true })
  country!: string | null;

  @Column({ type: 'text', nullable: true })
  city!: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  @Column({ name: 'cover_url', type: 'text', nullable: true })
  coverUrl!: string | null;

  @Column({ name: 'max_members', type: 'int', nullable: true })
  maxMembers!: number | null;

  @Column({ name: 'member_count', type: 'int', default: 0 })
  memberCount!: number;

  @Column({ name: 'admin_suspended_at', type: 'timestamptz', nullable: true })
  adminSuspendedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => GroupMember, (gm) => gm.group)
  members?: GroupMember[];
}
