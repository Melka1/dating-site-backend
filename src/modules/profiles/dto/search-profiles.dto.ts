import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PROFESSIONS } from './update-profile.dto';

const SORTS = ['newest', 'most_active', 'popular'] as const;
export type ProfileSort = typeof SORTS[number];

const csv = ({ value }: { value: unknown }): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return undefined;
};

export class SearchProfilesDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;

  @ApiPropertyOptional({ description: 'CSV or repeated values' })
  @IsOptional() @Transform(csv) @IsArray() @IsString({ each: true })
  seeking?: string[];

  @ApiPropertyOptional({ description: 'CSV or repeated values' })
  @IsOptional() @Transform(csv) @IsArray() @IsString({ each: true })
  interests?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional({
    enum: PROFESSIONS,
    isArray: true,
    description: 'CSV or repeated values — matches candidates whose profession is in the list',
  })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(PROFESSIONS as readonly string[], { each: true })
  profession?: Array<typeof PROFESSIONS[number]>;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(18) @Max(120) minAge?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(18) @Max(120) maxAge?: number;

  @ApiPropertyOptional({ description: 'Trigram match on display_name' })
  @IsOptional() @IsString() @MaxLength(80) q?: string;

  @ApiPropertyOptional({ description: 'When true, only return users currently online' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  online?: boolean;

  @ApiPropertyOptional({ enum: SORTS, default: 'newest' })
  @IsOptional() @IsIn(SORTS as readonly string[]) sort?: ProfileSort = 'newest';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}
