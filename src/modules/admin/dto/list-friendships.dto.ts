import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';

const STATUS = ['pending', 'accepted'] as const;

export class ListFriendshipsAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @ApiPropertyOptional({ enum: STATUS })
  @IsOptional()
  @IsIn(STATUS as readonly string[])
  status?: (typeof STATUS)[number];

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

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
