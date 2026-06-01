import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';

export class SubscribeDto {
  @ApiPropertyOptional({
    example: 'jane@example.com',
    description:
      'Required for guests; ignored for authenticated callers (their auth email is used).',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
