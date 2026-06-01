import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class ConfirmDto {
  @ApiProperty({ description: 'Signed token delivered in the confirmation email link.' })
  @IsJWT()
  token!: string;
}
