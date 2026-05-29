import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

export interface ApiResponse<T> {
  success: true;
  data: T;
  meta: {
    timestamp: string;
    path: string;
    requestId?: string;
  };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request & { id?: string }>();

    return next.handle().pipe(
      map((data) => {
        if (raw || data instanceof StreamableFile) return data;
        return {
          success: true,
          data,
          meta: {
            timestamp: new Date().toISOString(),
            path: req.url,
            requestId: req.id,
          },
        } as ApiResponse<T>;
      }),
    );
  }
}
