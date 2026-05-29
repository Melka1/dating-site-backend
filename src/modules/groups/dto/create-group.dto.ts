import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const VISIBILITY = ['public', 'unlisted', 'private'] as const;
const JOIN_POLICY = ['open', 'approval', 'invite_only'] as const;

export class CreateGroupDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  rules?: string;

  @ApiPropertyOptional({ enum: VISIBILITY })
  @IsOptional()
  @IsIn(VISIBILITY as readonly string[])
  visibility?: (typeof VISIBILITY)[number];

  @ApiPropertyOptional({ enum: JOIN_POLICY })
  @IsOptional()
  @IsIn(JOIN_POLICY as readonly string[])
  joinPolicy?: (typeof JOIN_POLICY)[number];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  interests?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100_000)
  maxMembers?: number;
}
