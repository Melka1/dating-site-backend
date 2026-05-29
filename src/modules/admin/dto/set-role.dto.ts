import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { UserRole } from '../../users/entities/user.entity';

export class SetRoleDto {
  @ApiProperty({ enum: UserRole })
  @IsIn(Object.values(UserRole))
  role!: UserRole;
}
