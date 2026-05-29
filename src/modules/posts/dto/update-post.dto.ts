import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { POST_AUDIENCES } from './create-post.dto';

export class UpdatePostDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  body?: string;

  @ApiPropertyOptional({ enum: POST_AUDIENCES, description: 'Cannot change to/from group' })
  @IsOptional()
  @IsIn(POST_AUDIENCES as readonly string[])
  audience?: (typeof POST_AUDIENCES)[number];
}
