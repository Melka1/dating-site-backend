import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'jane_doe', minLength: 3, maxLength: 24 })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{3,24}$/, {
    message: 'Username must be 3–24 chars, letters/digits/underscore/hyphen',
  })
  username?: string;
}
