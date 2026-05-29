import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const SORTS = ['newest', 'largest', 'most_active'] as const;
export type GroupSort = (typeof SORTS)[number];

const JOIN_POLICY = ['open', 'approval', 'invite_only'] as const;

const csv = ({ value }: { value: unknown }): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
};

export class SearchGroupsDto {
  @ApiPropertyOptional({ description: 'Trigram match on group name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ description: 'CSV or repeated values' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  interests?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @ApiPropertyOptional({ enum: JOIN_POLICY })
  @IsOptional()
  @IsIn(JOIN_POLICY as readonly string[])
  joinPolicy?: (typeof JOIN_POLICY)[number];

  @ApiPropertyOptional({ enum: SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(SORTS as readonly string[])
  sort?: GroupSort = 'newest';

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
