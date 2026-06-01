import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export type Gender = 'male' | 'female' | 'non_binary' | 'other' | 'prefer_not_to_say';
export type MaritalStatus =
  | 'single'
  | 'married'
  | 'divorced'
  | 'widowed'
  | 'separated'
  | 'other';
export type RelationshipType =
  | 'serious'
  | 'casual'
  | 'friendship'
  | 'affair'
  | 'marriage'
  | 'open';
export type Children = 'none' | 'have' | 'want' | 'dont_want' | 'maybe';
export type Smoking = 'never' | 'casual' | 'regular' | 'trying_to_quit';
export type Drinking = 'never' | 'socially' | 'regularly';
export type Visibility = 'public' | 'members_only' | 'private';
export type Profession =
  | 'PAINTER' | 'PHOTOGRAPHER' | 'MODEL' | 'PROJECT_MANAGER' | 'DEVELOPER'
  | 'MUSICIAN' | 'SINGER' | 'PRODUCER' | 'DIRECTOR' | 'RAPPER'
  | 'VIDEOGRAPHER' | 'EDITOR_WRITING' | 'EDITOR_VIDEO' | 'GRAPHIC_DESIGNER'
  | 'WEB_DEVELOPER' | 'VENUE' | 'SEAMSTRESS' | 'ACTOR_ACTRESS'
  | 'MAKEUP_ARTIST' | 'INTERIOR_DECORATOR' | 'CATERER' | 'PROMOTER'
  | 'PRINTER' | 'DANCER' | 'ARCHITECT' | 'ENGINEER' | 'CONTRACTOR'
  | 'WRITER' | 'STYLIST' | 'VOICEOVER_ARTIST' | 'SONGWRITER';

@Entity({ name: 'profiles' })
export class Profile {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  gender!: Gender | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  seeking!: string[];

  @Column({ type: 'date', nullable: true })
  dob!: string | null;

  @Column({ name: 'marital_status', type: 'text', nullable: true })
  maritalStatus!: MaritalStatus | null;

  @Column({ name: 'relationship_type', type: 'text', nullable: true })
  relationshipType!: RelationshipType | null;

  @Column({ type: 'text', nullable: true })
  country!: string | null;

  @Column({ type: 'text', nullable: true })
  city!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ name: 'looking_for', type: 'text', nullable: true })
  lookingFor!: string | null;

  @Column({ type: 'text', nullable: true })
  likes!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  interests!: string[];

  @Column({ name: 'favorite_places', type: 'text', array: true, default: () => "'{}'" })
  favoritePlaces!: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  languages!: string[];

  @Column({ type: 'text', nullable: true })
  religion!: string | null;

  @Column({ type: 'text', nullable: true })
  children!: Children | null;

  @Column({ type: 'text', nullable: true })
  smoking!: Smoking | null;

  @Column({ type: 'text', nullable: true })
  drinking!: Drinking | null;

  @Column({ name: 'height_cm', type: 'int', nullable: true })
  heightCm!: number | null;

  @Column({ name: 'weight_kg', type: 'int', nullable: true })
  weightKg!: number | null;

  @Column({ name: 'hair_color', type: 'text', nullable: true })
  hairColor!: string | null;

  @Column({ name: 'eye_color', type: 'text', nullable: true })
  eyeColor!: string | null;

  @Column({ name: 'body_type', type: 'text', nullable: true })
  bodyType!: string | null;

  @Column({ type: 'text', nullable: true })
  ethnicity!: string | null;

  @Column({ type: 'text', nullable: true })
  profession!: Profession | null;

  @Column({ name: 'seeking_professions', type: 'text', array: true, default: () => "'{}'" })
  seekingProfessions!: string[];

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  @Column({ name: 'cover_url', type: 'text', nullable: true })
  coverUrl!: string | null;

  @Column({ type: 'text', default: 'public' })
  visibility!: Visibility;

  @Column({ name: 'completion_score', type: 'int', default: 0 })
  completionScore!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToOne(() => User, (u) => u.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
