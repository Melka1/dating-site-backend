import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../modules/auth/types/jwt-payload.type';
import { Viewer, viewerFromJwt } from '../viewer';

/**
 * Always returns a {@link Viewer}, never undefined. On routes guarded by the
 * default JwtAuthGuard the Viewer is authenticated; on `@OptionalAuth()`
 * routes it may be a guest (`userId: null`).
 */
export const CurrentViewer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Viewer => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    return viewerFromJwt(req.user);
  },
);
