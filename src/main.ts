import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<AppConfig, true>);

  const apiPrefix = config.get('app.apiPrefix', { infer: true });
  const apiVersion = config.get('app.apiVersion', { infer: true });

  app.setGlobalPrefix(apiPrefix);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: apiVersion.replace(/^v/i, ''),
  });

  app.use(helmet());
  app.use(compression());
  app.enableCors({
    origin: [
      'http://localhost:5173',
      'https://turulav-dark.vercel.app',
      /^https:\/\/turulav-dark-[a-z0-9-]+\.vercel\.app$/,
    ],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(app.get(Logger)));
  app.useGlobalInterceptors(new TransformInterceptor(app.get(Reflector)));

  app.enableShutdownHooks();

  if (config.get('swagger.enabled', { infer: true })) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.get('app.name', { infer: true }))
      .setDescription('Dating site backend API')
      .setVersion(apiVersion)
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(config.get('swagger.path', { infer: true }), app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = config.get('app.port', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Server running on http://localhost:${port}/${apiPrefix}/${apiVersion}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
