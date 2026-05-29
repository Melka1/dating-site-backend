import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RenameSlugDto {
  @ApiProperty({ description: 'New URL slug; lowercase alnum + dashes, 3-40 chars.' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{2,39}$/, {
    message: 'Slug must start with [a-z0-9] and be 3-40 chars of [a-z0-9-]',
  })
  slug!: string;
}
