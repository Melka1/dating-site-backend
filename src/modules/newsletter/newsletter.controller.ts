import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { JwtPayload } from '../auth/types/jwt-payload.type';
import { ConfirmDto } from './dto/confirm.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { UnsubscribeDto } from './dto/unsubscribe.dto';
import { NewsletterService, SubscribeResult } from './newsletter.service';

@ApiTags('newsletter')
@Controller({ path: 'newsletter', version: '1' })
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}

  @OptionalAuth()
  @ApiBearerAuth()
  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Subscribe to the newsletter. Guests must supply `email` and complete double opt-in; authenticated callers are activated immediately using their verified auth email.',
  })
  async subscribe(
    @Body() dto: SubscribeDto,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<SubscribeResult> {
    if (user) {
      if (!user.emailConfirmedAt) {
        throw new BadRequestException('Confirm your account email before subscribing');
      }
      return this.newsletter.subscribeAuthenticated(user.sub, user.email);
    }
    if (!dto.email) {
      throw new BadRequestException('email is required for guest subscriptions');
    }
    return this.newsletter.subscribeGuest(dto.email);
  }

  @Public()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a pending guest subscription using the email-link token.' })
  confirm(@Body() dto: ConfirmDto) {
    return this.newsletter.confirm(dto.token);
  }

  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsubscribe using the signed token in the email footer.' })
  unsubscribe(@Body() dto: UnsubscribeDto) {
    return this.newsletter.unsubscribe(dto.token);
  }
}
