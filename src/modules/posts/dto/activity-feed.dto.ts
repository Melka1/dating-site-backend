import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const ACTIVITY_LENSES = [
  'personal',
  'mentions',
  'favorites',
  'friends',
  'groups',
] as const;
export type ActivityLens = (typeof ACTIVITY_LENSES)[number];

export const ACTIVITY_SORTS = ['recent', 'popular', 'relevant'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

export class ActivityFeedQueryDto {
  @ApiPropertyOptional({ enum: ACTIVITY_LENSES, default: 'personal' })
  @IsOptional()
  @IsIn(ACTIVITY_LENSES as readonly string[])
  lens: ActivityLens = 'personal';

  @ApiPropertyOptional({ enum: ACTIVITY_SORTS, default: 'recent' })
  @IsOptional()
  @IsIn(ACTIVITY_SORTS as readonly string[])
  sort: ActivitySort = 'recent';

  @ApiPropertyOptional({ description: 'Opaque pagination cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
