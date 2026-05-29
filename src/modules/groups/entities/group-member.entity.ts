import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Group } from './group.entity';

export enum GroupMemberRole {
  MEMBER = 'member',
  MODERATOR = 'moderator',
  ADMIN = 'admin',
  OWNER = 'owner',
}

export enum GroupMemberStatus {
  INVITED = 'invited',
  PENDING = 'pending',
  ACTIVE = 'active',
  BANNED = 'banned',
}

@Entity({ name: 'group_members' })
export class GroupMember {
  @PrimaryColumn({ name: 'group_id', type: 'uuid' })
  groupId!: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'text', default: GroupMemberRole.MEMBER })
  role!: GroupMemberRole;

  @Column({ type: 'text', default: GroupMemberStatus.ACTIVE })
  status!: GroupMemberStatus;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy!: string | null;

  @Column({ name: 'joined_at', type: 'timestamptz', nullable: true })
  joinedAt!: Date | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ name: 'banned_until', type: 'timestamptz', nullable: true })
  bannedUntil!: Date | null;

  @Column({ name: 'ban_reason', type: 'text', nullable: true })
  banReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => Group, (g) => g.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group?: Group;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
