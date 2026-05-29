import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class RestoreDto {
  @ApiProperty({ description: 'Signed restore token issued at soft-delete time.' })
  @IsJWT()
  token!: string;
}
