import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export const POST_AUDIENCES = ['public', 'friends', 'private', 'group'] as const;
export const ATTACHMENT_KINDS = ['photo', 'video'] as const;

/**
 * Multipart body fields for `POST /posts`. Files are sent under the `files`
 * field (max 10 per post) — see StorageService for mime + size caps.
 */
export class CreatePostDto {
  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  body!: string;

  @ApiProperty({ enum: POST_AUDIENCES })
  @IsIn(POST_AUDIENCES as readonly string[])
  audience!: (typeof POST_AUDIENCES)[number];

  @ApiPropertyOptional({ description: 'Required iff audience=group' })
  @IsOptional()
  @IsUUID('4')
  groupId?: string;
}
