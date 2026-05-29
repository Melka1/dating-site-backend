import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class SignupDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'S3cure!passphrase' })
  @IsString()
  @Length(8, 128)
  password!: string;

  @ApiProperty({ example: 'Jane Doe', minLength: 2, maxLength: 40 })
  @IsString()
  @Length(2, 40)
  displayName!: string;

  @ApiProperty({
    example: 'jane_doe',
    minLength: 3,
    maxLength: 24,
    description:
      'Handle obtained from POST /auth/username-suggestions. Must match the slug pattern and be currently available.',
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, {
    message: 'Username must be 3–24 chars, lowercase letters/digits/underscore/hyphen, no edge separators',
  })
  @Length(3, 24)
  username!: string;
}
