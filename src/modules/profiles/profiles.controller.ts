import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentViewer } from '../../common/decorators/current-viewer.decorator';
import type { UploadedFile } from '../../common/storage/storage.service';
import type { Viewer } from '../../common/viewer';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { RequireVerified } from '../auth/decorators/require-verified.decorator';
import { NewMembersDto } from './dto/new-members.dto';
import { SearchProfilesDto } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilesService } from './profiles.service';

type ProfileUploadFields = {
  avatar?: UploadedFile[];
  cover?: UploadedFile[];
};

// Single-shot multipart: any subset of the JSON profile fields + optional
// `avatar` (1 file) + optional `cover` (1 file) in one request.
const PROFILE_UPLOAD_FIELDS = [
  { name: 'avatar', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
];

@ApiTags('profiles')
@ApiBearerAuth()
@Controller({ path: 'profiles', version: '1' })
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  findMe(@CurrentUser('sub') userId: string) {
    return this.profiles.findMe(userId);
  }

  @RequireVerified()
  @Patch('me')
  @UseInterceptors(FileFieldsInterceptor(PROFILE_UPLOAD_FIELDS))
  @ApiConsumes('multipart/form-data', 'application/json')
  patchMe(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateProfileDto,
    @UploadedFiles() files: ProfileUploadFields = {},
  ) {
    return this.profiles.patchMe(userId, dto, files.avatar?.[0], files.cover?.[0]);
  }

  @OptionalAuth()
  @Get('search')
  search(@Query() query: SearchProfilesDto, @CurrentViewer() viewer: Viewer) {
    return this.profiles.search(query, viewer);
  }

  @OptionalAuth()
  @Get('new')
  findNew(@Query() query: NewMembersDto, @CurrentViewer() viewer: Viewer) {
    return this.profiles.findNew(query, viewer);
  }

  @OptionalAuth()
  @Get(':userId')
  findPublic(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.profiles.findPublic(userId, viewer);
  }
}
