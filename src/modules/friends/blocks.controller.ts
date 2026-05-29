import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireVerified } from '../auth/decorators/require-verified.decorator';
import { BlocksService } from './blocks.service';
import { BlockUserDto } from './dto/block-user.dto';
import { ListRequestsDto } from './dto/list-requests.dto';

@ApiTags('blocks')
@ApiBearerAuth()
@Controller({ path: 'blocks', version: '1' })
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  list(@CurrentUser('sub') actorId: string, @Query() query: ListRequestsDto) {
    return this.blocks.listBlocks(actorId, query);
  }

  @RequireVerified()
  @Post(':userId')
  block(
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() dto: BlockUserDto,
  ) {
    return this.blocks.block(actorId, targetUserId, dto);
  }

  @RequireVerified()
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unblock(
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.blocks.unblock(actorId, targetUserId);
  }
}
