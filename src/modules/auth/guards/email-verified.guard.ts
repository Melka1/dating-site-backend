import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRE_VERIFIED_KEY } from '../decorators/require-verified.decorator';
import type { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_VERIFIED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user;
    if (!user) throw new ForbiddenException({ code: 'EMAIL_UNVERIFIED', message: 'Unauthenticated' });
    if (!user.emailConfirmedAt) {
      throw new ForbiddenException({
        code: 'EMAIL_UNVERIFIED',
        message: 'Email verification required',
      });
    }
    return true;
  }
}
