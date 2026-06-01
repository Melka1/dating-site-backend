export interface AppConfig {
  app: {
    name: string;
    env: 'development' | 'test' | 'staging' | 'production';
    port: number;
    apiPrefix: string;
    apiVersion: string;
    corsOrigins: string[] | boolean;
  };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    schema: string;
    ssl: boolean;
    synchronize: boolean;
    logging: boolean;
  };
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    jwtSecret: string;
    avatarBucket: string;
    coverBucket: string;
    groupAvatarBucket: string;
    groupCoverBucket: string;
    postMediaBucket: string;
    blogMediaBucket: string;
  };
  jwt: {
    restoreSecret: string;
    restoreExpiresIn: string;
  };
  email: {
    resendApiKey: string;
    from: string;
    fromName: string;
    appBaseUrl: string;
  };
  throttle: {
    ttl: number;
    limit: number;
    guestTtl: number;
    guestLimit: number;
  };
  swagger: {
    enabled: boolean;
    path: string;
  };
  logger: {
    level: string;
  };
  presence: {
    offlineThresholdSeconds: number;
  };
  retention: {
    softDeleteGraceDays: number;
  };
}

const parseOrigins = (value?: string): string[] | boolean => {
  if (!value || value === '*') return true;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

export default (): AppConfig => ({
  app: {
    name: process.env.APP_NAME ?? 'dating-site-backend',
    env: (process.env.NODE_ENV as AppConfig['app']['env']) ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    apiVersion: process.env.API_VERSION ?? 'v1',
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  },
  database: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    username: process.env.DATABASE_USERNAME ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? '',
    name: process.env.DATABASE_NAME ?? 'postgres',
    schema: process.env.DATABASE_SCHEMA ?? 'public',
    ssl: (process.env.DATABASE_SSL ?? 'true').toLowerCase() === 'true',
    synchronize: (process.env.DATABASE_SYNCHRONIZE ?? 'false').toLowerCase() === 'true',
    logging: (process.env.DATABASE_LOGGING ?? 'false').toLowerCase() === 'true',
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
    avatarBucket: process.env.SUPABASE_AVATAR_BUCKET ?? 'avatars',
    coverBucket: process.env.SUPABASE_COVER_BUCKET ?? 'covers',
    groupAvatarBucket: process.env.SUPABASE_GROUP_AVATAR_BUCKET ?? 'group-avatars',
    groupCoverBucket: process.env.SUPABASE_GROUP_COVER_BUCKET ?? 'group-covers',
    postMediaBucket: process.env.SUPABASE_POST_MEDIA_BUCKET ?? 'post-media',
    blogMediaBucket: process.env.SUPABASE_BLOG_MEDIA_BUCKET ?? 'blog-media',
  },
  jwt: {
    restoreSecret: process.env.RESTORE_TOKEN_SECRET ?? 'dev-restore-secret-change-me',
    restoreExpiresIn: process.env.RESTORE_TOKEN_EXPIRES_IN ?? '60d',
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? 'onboarding@resend.dev',
    fromName: process.env.EMAIL_FROM_NAME ?? 'Turulav',
    appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
    guestTtl: parseInt(process.env.THROTTLE_GUEST_TTL ?? '60', 10),
    guestLimit: parseInt(process.env.THROTTLE_GUEST_LIMIT ?? '30', 10),
  },
  swagger: {
    enabled: (process.env.SWAGGER_ENABLED ?? 'true').toLowerCase() === 'true',
    path: process.env.SWAGGER_PATH ?? 'docs',
  },
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  presence: {
    offlineThresholdSeconds: parseInt(
      process.env.PRESENCE_OFFLINE_THRESHOLD_SECONDS ?? '120',
      10,
    ),
  },
  retention: {
    softDeleteGraceDays: parseInt(process.env.SOFT_DELETE_GRACE_DAYS ?? '60', 10),
  },
});
