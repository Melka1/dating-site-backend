import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class CreateBlogTagDto {
  @ApiProperty({ description: 'URL-safe slug, lower-kebab' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @Length(1, 60)
  slug!: string;

  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @Length(1, 60)
  name!: string;
}

export class UpdateBlogTagDto {
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @Length(1, 60)
  name!: string;
}
