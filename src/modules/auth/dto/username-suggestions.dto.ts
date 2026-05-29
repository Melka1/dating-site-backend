import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class UsernameSuggestionsDto {
  @ApiProperty({ example: 'Jane Doe', minLength: 2, maxLength: 40 })
  @IsString()
  @Length(2, 40)
  displayName!: string;
}

export interface UsernameSuggestionsResponse {
  /** Canonical slug derived from the submitted displayName. */
  username: string;
  /** Whether `username` is currently free (and a valid handle). */
  available: boolean;
  /** Alternate available handles when `available` is false. May be empty. */
  suggestions: string[];
}
