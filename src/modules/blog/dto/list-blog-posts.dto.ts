import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BLOG_POST_STATUSES } from './create-blog-post.dto';

export const BLOG_LIST_SORTS = ['recent', 'popular'] as const;

export class ListBlogPostsDto {
  @ApiPropertyOptional({ description: 'Free-text search across title/excerpt' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Filter by tag slug' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  tag?: string;

  @ApiPropertyOptional({ description: 'Filter by author id' })
  @IsOptional()
  @IsUUID('4')
  authorId?: string;

  @ApiPropertyOptional({
    enum: BLOG_POST_STATUSES,
    description: 'Editors only — non-editors are clamped to "published"',
  })
  @IsOptional()
  @IsIn(BLOG_POST_STATUSES as readonly string[])
  status?: (typeof BLOG_POST_STATUSES)[number];

  @ApiPropertyOptional({ enum: BLOG_LIST_SORTS, default: 'recent' })
  @IsOptional()
  @IsIn(BLOG_LIST_SORTS as readonly string[])
  sort: (typeof BLOG_LIST_SORTS)[number] = 'recent';

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 12;
}
