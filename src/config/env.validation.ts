import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  APP_NAME: Joi.string().default('dating-site-backend'),
  API_PREFIX: Joi.string().default('api'),
  API_VERSION: Joi.string().default('v1'),
  CORS_ORIGINS: Joi.string().optional(),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USERNAME: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().allow('').required(),
  DATABASE_NAME: Joi.string().default('postgres'),
  DATABASE_SCHEMA: Joi.string().default('public'),
  DATABASE_SSL: Joi.boolean().truthy('true').falsy('false').default(true),
  DATABASE_SYNCHRONIZE: Joi.boolean().truthy('true').falsy('false').default(false),
  DATABASE_LOGGING: Joi.boolean().truthy('true').falsy('false').default(false),

  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
  SUPABASE_JWT_SECRET: Joi.string().min(16).required(),
  SUPABASE_AVATAR_BUCKET: Joi.string().default('avatars'),
  SUPABASE_COVER_BUCKET: Joi.string().default('covers'),
  SUPABASE_GROUP_AVATAR_BUCKET: Joi.string().default('group-avatars'),
  SUPABASE_GROUP_COVER_BUCKET: Joi.string().default('group-covers'),
  SUPABASE_POST_MEDIA_BUCKET: Joi.string().default('post-media'),
  SUPABASE_BLOG_MEDIA_BUCKET: Joi.string().default('blog-media'),

  RESTORE_TOKEN_SECRET: Joi.string().min(16).required(),
  RESTORE_TOKEN_EXPIRES_IN: Joi.string().default('60d'),

  RESEND_API_KEY: Joi.string().optional(),
  EMAIL_FROM: Joi.string().email().default('onboarding@resend.dev'),
  EMAIL_FROM_NAME: Joi.string().default('Turulav'),
  APP_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
  THROTTLE_GUEST_TTL: Joi.number().default(60),
  THROTTLE_GUEST_LIMIT: Joi.number().default(30),

  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  SWAGGER_PATH: Joi.string().default('docs'),

  PRESENCE_OFFLINE_THRESHOLD_SECONDS: Joi.number().default(120),
  SOFT_DELETE_GRACE_DAYS: Joi.number().default(60),
});
