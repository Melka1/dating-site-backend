import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ATTACHMENT_KINDS } from './create-post.dto';

export class UserMediaQueryDto {
  @ApiPropertyOptional({ enum: ATTACHMENT_KINDS, description: 'Filter to a single kind' })
  @IsOptional()
  @IsIn(ATTACHMENT_KINDS as readonly string[])
  kind?: (typeof ATTACHMENT_KINDS)[number];

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

/** Single media tile in a user's gallery. */
export interface UserMediaItemDto {
  attachmentId: string;
  postId: string;
  kind: 'photo' | 'video';
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  postCreatedAt: string;
}

export interface UserMediaResponse {
  items: UserMediaItemDto[];
  nextCursor: string | null;
}
