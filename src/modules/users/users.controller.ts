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
  @Post('me/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@CurrentUser('sub') userId: string) {
    await this.users.heartbeat(userId);
  }

  @RequireVerified()
  @Delete('me/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async goOffline(@CurrentUser('sub') userId: string) {
    await this.users.goOffline(userId);
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
