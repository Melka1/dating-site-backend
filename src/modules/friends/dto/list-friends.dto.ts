import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const SORTS = ['newest', 'name'] as const;
export type FriendSort = (typeof SORTS)[number];

export class ListFriendsDto {
  @ApiPropertyOptional({ description: 'Match on username (case-insensitive substring).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @ApiPropertyOptional({ enum: SORTS, default: 'newest' })
  @Transform(({ value }) => value ?? 'newest')
  @IsIn(SORTS as readonly string[])
  sort: FriendSort = 'newest';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
