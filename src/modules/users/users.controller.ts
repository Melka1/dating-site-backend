import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
// Presence (online/offline) is now driven by the /presence Socket.IO gateway —
// see presence.gateway.ts. The previous POST/DELETE /users/me/presence
// heartbeat endpoints were removed when polling was replaced with sockets.
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentViewer } from '../../common/decorators/current-viewer.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { Viewer } from '../../common/viewer';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { RequireVerified } from '../auth/decorators/require-verified.decorator';
import { ProfilesService } from '../profiles/profiles.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { RestoreDto } from './dto/restore.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
  ) {}

  @Get('me')
  findMe(@CurrentUser('sub') userId: string) {
    return this.users.findMe(userId);
  }

  @RequireVerified()
  @Patch('me')
  patchMe(@CurrentUser('sub') userId: string, @Body() dto: UpdateMeDto) {
    return this.users.patchMe(userId, dto);
  }

  @RequireVerified()
  @Delete('me')
  @HttpCode(HttpStatus.ACCEPTED)
  softDelete(@CurrentUser('sub') userId: string) {
    return this.users.softDelete(userId, userId);
  }

  @Public()
  @Post('me/restore')
  @HttpCode(HttpStatus.OK)
  restore(@Body() dto: RestoreDto) {
    return this.users.restore(dto.token);
  }

  @OptionalAuth()
  @Get(':id')
  findPublic(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.profiles.findPublic(id, viewer);
  }
}
