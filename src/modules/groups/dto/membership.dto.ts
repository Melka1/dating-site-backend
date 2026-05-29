import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { GroupMemberRole } from '../entities/group-member.entity';

const ROLE_ASSIGNABLE = [
  GroupMemberRole.MEMBER,
  GroupMemberRole.MODERATOR,
  GroupMemberRole.ADMIN,
] as const;

export class InviteMembersDto {
  @ApiProperty({ isArray: true, type: String, description: 'User IDs to invite (max 50)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  userIds!: string[];
}

export class SetGroupRoleDto {
  @ApiProperty({ enum: ROLE_ASSIGNABLE })
  @IsIn(ROLE_ASSIGNABLE as readonly string[])
  role!: (typeof ROLE_ASSIGNABLE)[number];
}

export class BanMemberDto {
  @ApiPropertyOptional({ description: 'ISO8601; omit for indefinite ban' })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export class TransferOwnerDto {
  @ApiProperty({ description: 'User ID of the new owner; must be an admin in the group.' })
  @IsUUID('4')
  newOwnerId!: string;
}
