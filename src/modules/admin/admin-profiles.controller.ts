import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: 'admin/profiles', version: '1' })
export class AdminProfilesController {
  // Placeholder for the Reports model. Returns an empty list until reports land.
  @Get('flagged')
  flagged() {
    return { items: [], total: 0 };
  }
}
