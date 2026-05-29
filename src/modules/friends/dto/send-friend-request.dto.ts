import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SendFriendRequestDto {
  @ApiProperty({ description: 'User ID to send a friend request to.' })
  @IsUUID('4')
  targetUserId!: string;

  @ApiPropertyOptional({ maxLength: 280, description: 'Optional greeting attached to the request.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  message?: string;
}
