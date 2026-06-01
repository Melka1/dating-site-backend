import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export const BLOG_POST_STATUSES = ['draft', 'published', 'archived'] as const;
export const BLOG_POST_TYPES = ['news', 'story', 'tips', 'advice'] as const;

/**
 * Parse a JSON-stringified array body coming in as a multipart text field.
 * Leaves arrays alone (covers the "raw JSON request, no multipart" case
 * that may be useful in tests). Bad JSON falls through to class-validator,
 * which will reject it with `IsArray`.
 */
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
 * Multipart body for `POST /blog/posts`. One request carries everything:
 *
 *  - `cover`  — single image file (optional). Cover for the post when set.
 *  - `media`  — repeated image files (up to 20). Body image blocks reference
 *               these by zero-based `ref` (e.g. `{ "ref": 0 }` for the
 *               first file in the `media` field).
 *  - `body`   — JSON-stringified array of BlogBlocks. Image items inside the
 *               body either reference a `media` file by `ref`, or carry an
 *               existing `url` (must point at the blog media bucket).
 *  - `coverVideoUrl` — YouTube/Vimeo URL when the cover is a video instead
 *               of an uploaded image. Mutually exclusive with `cover`.
 *
 * Cover is image XOR video (a `cover` file plus a `coverVideoUrl` is a 400).
 */
export class CreateBlogPostDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Derived from first paragraph if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiProperty({
    type: 'string',
    description:
      'JSON-stringified array of BlogBlocks (paragraph | image | quote | list). Image items use { ref: N } to point at the N-th `media` file, or { url } to keep an existing URL.',
  })
  @Transform(({ value }) => parseJsonArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  body!: unknown[];

  @ApiPropertyOptional({ description: 'Cover video URL — YouTube or Vimeo.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverVideoUrl?: string;

  @ApiPropertyOptional({ type: [String], description: 'Tag slugs to attach' })
  @IsOptional()
  @Transform(({ value }) => splitTagSlugs(value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { each: true })
  tagSlugs?: string[];

  @ApiPropertyOptional({ enum: BLOG_POST_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(BLOG_POST_STATUSES as readonly string[])
  status?: (typeof BLOG_POST_STATUSES)[number];

  @ApiPropertyOptional({ enum: BLOG_POST_TYPES, default: 'news' })
  @IsOptional()
  @IsIn(BLOG_POST_TYPES as readonly string[])
  type?: (typeof BLOG_POST_TYPES)[number];
}
