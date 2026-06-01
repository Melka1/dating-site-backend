import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class UnsubscribeDto {
  @ApiProperty({ description: 'Signed token delivered in the unsubscribe-link footer.' })
  @IsJWT()
  token!: string;
}
