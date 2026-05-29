import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { AccountStatus, UserRole } from '../../users/entities/user.entity';

export class ListUsersDto {
  @ApiPropertyOptional({ enum: AccountStatus })
  @IsOptional()
  @IsIn(Object.values(AccountStatus))
  status?: AccountStatus;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsIn(Object.values(UserRole))
  role?: UserRole;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  onboardingCompleted?: boolean;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound' })
  @IsOptional()
  @IsISO8601()
  createdAfter?: string;

  @ApiPropertyOptional({ description: 'ISO date, exclusive upper bound' })
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
