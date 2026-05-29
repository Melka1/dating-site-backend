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
import { ListFriendsDto } from './dto/list-friends.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { MatchSuggestionsDto } from './dto/match-suggestions.dto';
import { SendFriendRequestDto } from './dto/send-friend-request.dto';
import { FriendsService } from './friends.service';

@ApiTags('friends')
@ApiBearerAuth()
@Controller({ path: 'friends', version: '1' })
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  // ---- Requests ----

  @RequireVerified()
  @Post('requests')
  send(@CurrentUser('sub') actorId: string, @Body() dto: SendFriendRequestDto) {
    return this.friends.sendRequest(actorId, dto);
  }

  @Get('requests/incoming')
  incoming(
    @CurrentUser('sub') actorId: string,
    @Query() query: ListRequestsDto,
  ) {
    return this.friends.listIncoming(actorId, query);
  }

  @Get('requests/outgoing')
  outgoing(
    @CurrentUser('sub') actorId: string,
    @Query() query: ListRequestsDto,
  ) {
    return this.friends.listOutgoing(actorId, query);
  }

  @RequireVerified()
  @Post('requests/:id/accept')
  accept(
    @CurrentUser('sub') actorId: string,
    @Param('id') requestId: string,
  ) {
    return this.friends.acceptRequest(actorId, requestId);
  }

  @RequireVerified()
  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(
    @CurrentUser('sub') actorId: string,
    @Param('id') requestId: string,
  ) {
    return this.friends.declineRequest(actorId, requestId);
  }

  @RequireVerified()
  @Delete('requests/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(
    @CurrentUser('sub') actorId: string,
    @Param('id') requestId: string,
  ) {
    return this.friends.cancelRequest(actorId, requestId);
  }

  // ---- Friends list / status / unfriend ----

  @Get()
  list(@CurrentUser('sub') actorId: string, @Query() query: ListFriendsDto) {
    return this.friends.listFriends(actorId, query);
  }

  @Get('suggestions')
  suggestions(@CurrentUser('sub') actorId: string) {
    return this.friends.suggestFriends(actorId).then((items) => ({ items }));
  }

  @Get('suggestions/match')
  async matchSuggestions(
    @CurrentUser('sub') actorId: string,
    @Query() query: MatchSuggestionsDto,
  ) {
    const items = await this.friends.matchSuggestions(actorId, query.limit);
    return { items };
  }

  @Get('mutual/:userId')
  mutual(
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) otherUserId: string,
    @Query() query: ListRequestsDto,
  ) {
    return this.friends.mutualFriends(actorId, otherUserId, query);
  }

  @Get(':userId')
  status(
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) otherUserId: string,
  ) {
    return this.friends.getStatus(actorId, otherUserId);
  }

  @RequireVerified()
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unfriend(
    @CurrentUser('sub') actorId: string,
    @Param('userId', ParseUUIDPipe) otherUserId: string,
  ) {
    return this.friends.unfriend(actorId, otherUserId);
  }
}
