import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { GroupJoinPolicy, GroupVisibility } from '../entities/group.entity';

export class SuggestedGroupsDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

export class SuggestedGroup {
  id!: string;
  slug!: string;
  name!: string;
  description!: string | null;
  avatarUrl!: string | null;
  coverUrl!: string | null;
  visibility!: GroupVisibility;
  joinPolicy!: GroupJoinPolicy;
  interests!: string[];
  country!: string | null;
  city!: string | null;
  memberCount!: number;
  maxMembers!: number | null;
  memberAvatars!: string[];
  extraMembersBand!: string | null;
  sharedInterests!: number;
  friendsInGroup!: number;
  sameCountry!: number;
  sameCity!: number;
  score!: number;
}
