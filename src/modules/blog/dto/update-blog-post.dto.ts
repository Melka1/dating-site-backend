import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { BLOG_POST_STATUSES, BLOG_POST_TYPES } from './create-blog-post.dto';

const parseJsonArray = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

const splitTagSlugs = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
};

/**
 * Partial update. Pass only the fields you want to change.
 *
 * Cover handling — three knobs, all optional:
 *  - Upload a new `cover` file (multipart) → replaces the cover image.
 *  - `coverVideoUrl` text field → set to a YouTube/Vimeo URL to switch
 *    to a video cover; empty string to clear it.
 *  - `clearCover` text field, value `'true'` → unset whatever cover is set
 *    (image or video).
 *
 * For body images, existing items keep their `url` and newly uploaded
 * items (sent in the `media` multipart field) are referenced by `{ ref: N }`.
 * `body` is authoritative — pass the FULL new array when changing it.
 */
export class UpdateBlogPostDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiPropertyOptional({ type: 'string', description: 'JSON-stringified array of BlogBlocks' })
  @IsOptional()
  @Transform(({ value }) => parseJsonArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  body?: unknown[];

  @ApiPropertyOptional({ description: 'YouTube/Vimeo URL; empty string clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverVideoUrl?: string;

  @ApiPropertyOptional({ description: 'Pass "true" to clear the current cover (image or video).' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  clearCover?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(({ value }) => splitTagSlugs(value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { each: true })
  tagSlugs?: string[];

  @ApiPropertyOptional({ enum: BLOG_POST_STATUSES })
  @IsOptional()
  @IsIn(BLOG_POST_STATUSES as readonly string[])
  status?: (typeof BLOG_POST_STATUSES)[number];

  @ApiPropertyOptional({ enum: BLOG_POST_TYPES })
  @IsOptional()
  @IsIn(BLOG_POST_TYPES as readonly string[])
  type?: (typeof BLOG_POST_TYPES)[number];
}
