import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListGroupsAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;

  @ApiPropertyOptional({ description: 'Include soft-deleted rows.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includeDeleted?: boolean;

  @ApiPropertyOptional({ description: 'Filter for admin-suspended groups only.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  suspendedOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  createdAfter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  createdBefore?: string;

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
