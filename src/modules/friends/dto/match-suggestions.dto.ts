import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class MatchSuggestionsDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

export class MatchSuggestion {
  id!: string;
  username!: string;
  isOnline!: boolean;
  lastActiveAt!: Date | null;
  friendCount!: number;
  displayName!: string | null;
  avatarUrl!: string | null;
  gender!: string | null;
  dob!: string | null;
  country!: string | null;
  city!: string | null;
  bio!: string | null;
  sharedInterests!: number;
  sharedLanguages!: number;
  sameCountry!: number;
  sameCity!: number;
  sameReligion!: number;
  sameRelationshipType!: number;
  score!: number;
}
