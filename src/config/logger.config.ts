import { randomUUID } from 'crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'http';

export const loggerConfigFactory = async (): Promise<Params> => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
      genReqId: (req: IncomingMessage) =>
        (req.headers['x-request-id'] as string) ?? randomUUID(),
      customProps: () => ({ app: process.env.APP_NAME ?? 'dating-site-backend' }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.newPassword',
          'req.body.oldPassword',
          'req.body.token',
          'req.body.refreshToken',
        ],
        censor: '[redacted]',
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
      serializers: {
        req(req: IncomingMessage & { id?: string; method?: string; url?: string }) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res: ServerResponse) {
          return { statusCode: res.statusCode };
        },
      },
    },
  };
};
