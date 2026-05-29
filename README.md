# dating-site-backend

NestJS backend scaffold wired up for a Supabase-hosted Postgres database. Structured for a large, long-lived project: modular source layout, strict TypeScript, typed config, global validation, structured logging, auth, health checks, rate limiting, Swagger, and Docker.

---

## 1. Tech stack

| Concern | Choice |
| --- | --- |
| Framework | [NestJS](https://nestjs.com) 10 on Express |
| Language | TypeScript 5 (strict mode, path alias `@/*`) |
| Database | Supabase Postgres via [TypeORM](https://typeorm.io) + `pg` |
| Auth | JWT access + refresh (via `@nestjs/jwt` + `passport-jwt`), bcrypt password hashing |
| Validation | `class-validator` + `class-transformer` (global `ValidationPipe`) |
| Config | `@nestjs/config` with Joi env-var schema (fails fast on boot) |
| Logging | `nestjs-pino` (request-id, redaction, pretty in dev, JSON in prod) |
| Rate limiting | `@nestjs/throttler` (registered as a global guard) |
| Health | `@nestjs/terminus` (DB ping + memory checks) |
| API docs | `@nestjs/swagger` at `/docs` |
| Security headers | `helmet` |
| Compression | `compression` |
| Testing | Jest + Supertest |
| Lint / format | ESLint + Prettier |
| Containerization | Multi-stage Dockerfile + docker-compose |

---

## 2. Project structure

```
src/
├── main.ts                             bootstrap: prefix, URI versioning, CORS, helmet, pipes/filters/interceptors, Swagger
├── app.module.ts                       wires config, logger, throttler, database, feature modules; throttler is a global guard
│
├── config/
│   ├── configuration.ts                typed AppConfig (app, database, supabase, jwt, throttle, swagger, logger)
│   ├── env.validation.ts               Joi schema — process crashes on invalid/missing env
│   └── logger.config.ts                Pino factory (pretty in dev, JSON in prod, redacts auth/password)
│
├── common/
│   ├── filters/all-exceptions.filter.ts         unified error envelope; logs 5xx with full stack
│   ├── interceptors/transform.interceptor.ts    { success, data, meta } envelope; skip with @RawResponse
│   └── decorators/
│       ├── public.decorator.ts                  @Public — lets JwtAuthGuard bypass a route
│       ├── current-user.decorator.ts            @CurrentUser — pulls JwtPayload off the request
│       └── raw-response.decorator.ts            @RawResponse — opt out of the response envelope
│
├── database/
│   ├── database.module.ts              async TypeOrmModule.forRootAsync
│   ├── typeorm-options.ts              Supabase-aware (SSL with rejectUnauthorized=false)
│   ├── data-source.ts                  standalone DataSource for the TypeORM CLI (migrations)
│   └── migrations/                     generated migrations land here
│
└── modules/
    ├── users/
    │   ├── entities/user.entity.ts     uuid PK, unique email, bcrypt hash, role enum, soft-delete, audit timestamps
    │   ├── dto/                        CreateUserDto, UpdateUserDto
    │   ├── users.service.ts            CRUD + password verify + lastLoginAt touch
    │   ├── users.controller.ts         JWT-guarded; /users/me, list, get, update, soft-delete
    │   └── users.module.ts
    │
    ├── auth/
    │   ├── dto/                        LoginDto, RefreshTokenDto
    │   ├── strategies/jwt.strategy.ts  validates Bearer tokens
    │   ├── guards/
    │   │   ├── jwt-auth.guard.ts       honors @Public
    │   │   └── roles.guard.ts          pairs with @Roles(...)
    │   ├── decorators/roles.decorator.ts
    │   ├── types/jwt-payload.type.ts   { sub, email, role }
    │   ├── auth.service.ts             register / login / refresh; dual-secret refresh tokens
    │   ├── auth.controller.ts          public endpoints: /auth/register, /auth/login, /auth/refresh
    │   └── auth.module.ts
    │
    └── health/
        ├── health.controller.ts        /health, /health/liveness, /health/readiness
        └── health.module.ts
```

### Root files

| File | Purpose |
| --- | --- |
| `package.json` | deps + scripts (dev, build, test, lint, migrations) |
| `tsconfig.json` / `tsconfig.build.json` | strict TS, path alias `@/*` |
| `nest-cli.json` | Nest CLI config |
| `.prettierrc` | formatter rules |
| `.eslintrc.cjs` | lint config (TS + Prettier) |
| `.env.example` | documented template for environment variables |
| `.gitignore` / `.dockerignore` | VCS and Docker build excludes |
| `Dockerfile` | multi-stage (deps → build → slim runtime on `node:22-alpine`, non-root user) |
| `docker-compose.yml` | runs the API container with healthcheck against `/api/v1/health` |

---

## 3. Getting started

### Prerequisites
- Node.js **20+** (tested on Node 25)
- npm
- A Supabase project (for the Postgres database)

### Setup

```bash
# 1. Install deps (already done once during scaffolding)
npm install

# 2. Create your env file
cp .env.example .env

# 3. Fill in Supabase Postgres credentials (see .env.example comments):
#    DATABASE_HOST=aws-0-REGION.pooler.supabase.com
#    DATABASE_PORT=6543                       # pooler (Transaction mode)
#    DATABASE_USERNAME=postgres.YOUR-PROJECT-REF
#    DATABASE_PASSWORD=...
#    DATABASE_NAME=postgres
#    DATABASE_SSL=true
#
#    Also set strong random secrets for:
#    JWT_SECRET
#    JWT_REFRESH_SECRET

# 4. Generate the initial migration from the current entities
npm run migration:generate -- src/database/migrations/Init
npm run migration:run

# 5. Start in watch mode
npm run start:dev
```

Service will be available at:
- API base: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/docs`
- Health:  `http://localhost:3000/api/v1/health`

### Supabase connection notes
- Use the **pooler host** (`aws-0-REGION.pooler.supabase.com:6543`) in serverless or short-lived-connection environments. Use the direct host on port `5432` if you need long-lived connections or features the pooler doesn't support (e.g. `LISTEN/NOTIFY`).
- SSL is required — the TypeORM config sets `ssl: { rejectUnauthorized: false }` when `DATABASE_SSL=true`.
- Supabase's own managed auth tables live in the `auth` schema. This project's `users` table lives in `public.users` and is independent. You can integrate with Supabase Auth later if you prefer to delegate identity.

---

## 4. Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | dev server with hot reload |
| `npm run start:debug` | dev server with `--inspect` for debuggers |
| `npm run build` | compile to `dist/` |
| `npm run start:prod` | run the compiled output (`node dist/main.js`) |
| `npm run lint` | ESLint with `--fix` |
| `npm run format` | Prettier write |
| `npm test` / `test:watch` / `test:cov` | Jest unit tests |
| `npm run test:e2e` | Jest e2e tests (config at `test/jest-e2e.json` — add when you write e2e tests) |
| `npm run migration:generate -- <path>` | diff entities vs DB and emit a migration file |
| `npm run migration:create <path>` | create an empty migration scaffold |
| `npm run migration:run` | apply pending migrations |
| `npm run migration:revert` | roll back the most recent migration |
| `npm run schema:drop` | drop all tables in the current schema (use with care) |

---

## 5. Environment variables

All variables are validated by Joi on boot; the app refuses to start if any required value is missing or malformed.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `staging` \| `production` |
| `PORT` | no | `3000` | HTTP listen port |
| `APP_NAME` | no | `dating-site-backend` | used in logs + Swagger title |
| `API_PREFIX` | no | `api` | global route prefix |
| `API_VERSION` | no | `v1` | URI versioning segment |
| `CORS_ORIGINS` | no | — | comma-separated list; `*` or empty allows all |
| `LOG_LEVEL` | no | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` |
| `DATABASE_HOST` | **yes** | — | Supabase pooler or direct host |
| `DATABASE_PORT` | no | `5432` | use `6543` for the Supabase pooler |
| `DATABASE_USERNAME` | **yes** | — | `postgres.YOUR-PROJECT-REF` for pooler |
| `DATABASE_PASSWORD` | **yes** | — | |
| `DATABASE_NAME` | no | `postgres` | |
| `DATABASE_SCHEMA` | no | `public` | |
| `DATABASE_SSL` | no | `true` | Supabase requires SSL |
| `DATABASE_SYNCHRONIZE` | no | `false` | **never** enable in production — use migrations |
| `DATABASE_LOGGING` | no | `false` | SQL logging |
| `SUPABASE_URL` | no | — | only if you use the Supabase JS SDK alongside TypeORM |
| `SUPABASE_ANON_KEY` | no | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | no | — | server-side only; never expose to clients |
| `JWT_SECRET` | **yes** | — | min 16 chars |
| `JWT_EXPIRES_IN` | no | `15m` | access token lifetime |
| `JWT_REFRESH_SECRET` | **yes** | — | must differ from `JWT_SECRET` |
| `JWT_REFRESH_EXPIRES_IN` | no | `7d` | |
| `THROTTLE_TTL` | no | `60` | seconds |
| `THROTTLE_LIMIT` | no | `100` | requests per TTL window per IP |
| `SWAGGER_ENABLED` | no | `true` | disable in production if you don't want public docs |
| `SWAGGER_PATH` | no | `docs` | mount path (after the global prefix is skipped) |

---

## 6. API overview

All routes are mounted under `/api/v1`. Responses use a consistent envelope from the global `TransformInterceptor`:

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-04-23T12:34:56.789Z",
    "path": "/api/v1/users/me",
    "requestId": "..."
  }
}
```

Errors follow the shape produced by `AllExceptionsFilter`:

```json
{
  "statusCode": 400,
  "message": ["email must be an email"],
  "error": "BadRequestException",
  "path": "/api/v1/auth/register",
  "timestamp": "2026-04-23T12:34:56.789Z",
  "requestId": "..."
}
```

### Auth (public)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | `{ email, password, displayName? }` | Creates a user + returns `{ user, tokens }` |
| `POST` | `/auth/login` | `{ email, password }` | Returns `{ user, tokens }` |
| `POST` | `/auth/refresh` | `{ refreshToken }` | Returns new `{ accessToken, refreshToken, expiresIn }` |

Tokens are JWTs signed with separate access/refresh secrets. Access tokens carry `{ sub, email, role }`.

### Users (requires `Authorization: Bearer <accessToken>`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/users/me` | Current authenticated user |
| `GET` | `/users` | List users |
| `GET` | `/users/:id` | Get by UUID |
| `PATCH` | `/users/:id` | Update (currently only `displayName`) |
| `DELETE` | `/users/:id` | Soft-delete |

### Health (public)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | DB ping + memory heap + memory RSS |
| `GET` | `/health/liveness` | Process is up |
| `GET` | `/health/readiness` | DB reachable |

---

## 7. Auth model

- Passwords hashed with **bcrypt** (12 rounds).
- Access tokens short-lived (`JWT_EXPIRES_IN`, default 15m).
- Refresh tokens signed with a **separate secret** (`JWT_REFRESH_SECRET`), longer-lived (default 7d). The separate-secret pattern ensures a leaked access token's secret can't be used to forge refresh tokens (and vice versa).
- `JwtAuthGuard` protects guarded controllers; `@Public()` marks routes to skip it.
- `RolesGuard` + `@Roles(UserRole.ADMIN)` provides role-based access control on top of the JWT.
- The `User` entity includes a `role` enum (`user` / `admin`) ready for that flow.

**Note:** refresh tokens are currently stateless (verified purely by signature + expiry). For higher security, you'd add a refresh-token store or rotation/revocation list — that's a natural next step when you need "log out everywhere" or compromise-recovery.

---

## 8. Database & migrations

TypeORM is configured in two places:

- **Runtime** — `src/database/typeorm-options.ts`, wired by `DatabaseModule` via `ConfigService`. `autoLoadEntities: true`, `synchronize: false`.
- **CLI** — `src/database/data-source.ts`, used by the `typeorm-ts-node-commonjs` CLI for migrations. It globs entities from `src/**/*.entity.{ts,js}` and migrations from `src/database/migrations`.

### Workflow

```bash
# edit an entity
# ...

# generate a migration from the diff between entities and the live DB
npm run migration:generate -- src/database/migrations/AddSomething

# apply
npm run migration:run

# roll back the last one
npm run migration:revert
```

`DATABASE_SYNCHRONIZE=true` is available for local experimentation only — do **not** enable it against Supabase or anywhere with real data.

---

## 9. Logging, errors, response shape

- **Pino** logs in JSON with request IDs (`x-request-id` header or generated UUID). In dev, `pino-pretty` produces single-line colorized output.
- Sensitive fields are redacted: `req.headers.authorization`, `req.headers.cookie`, `req.body.password`, `req.body.newPassword`, `req.body.oldPassword`, `req.body.token`, `req.body.refreshToken`.
- All unhandled errors funnel through `AllExceptionsFilter`. 5xx errors are logged with full stack; 4xx are logged at warn.
- All successful responses are wrapped by `TransformInterceptor`. Apply `@RawResponse()` to a handler to bypass the envelope (useful for file downloads, webhook responses, etc.).

---

## 10. Docker

```bash
# build and run the API (reads your .env)
docker compose up --build
```

- Multi-stage: `deps` (npm ci) → `build` (nest build + prune) → `runtime` (slim `node:22-alpine`, non-root `app` user).
- Compose healthcheck hits `GET /api/v1/health` every 30s.

---

## 11. Conventions

- **Strict TS** — `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- **No global barrel files.** Import from specific paths.
- **Path alias** `@/*` → `src/*`.
- **Feature modules** live under `src/modules/<feature>/` with a conventional layout: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/`, plus `strategies/`, `guards/`, `decorators/`, `types/` where relevant.
- **DTOs** do validation; entities are the persistence shape; controllers never receive raw entities from clients.
- **Serialization** — controllers declare `@UseInterceptors(ClassSerializerInterceptor)` and entities use `@Exclude()` to keep fields like `passwordHash` from leaking.

---

## 12. What's intentionally NOT in here

Left out so you can choose direction:

- **Email / SMS / push providers** — not wired.
- **File uploads** — Supabase Storage or S3 not configured; pick one when needed.
- **Queues / background jobs** — no BullMQ or similar yet.
- **Caching** — Redis not wired; add `@nestjs/cache-manager` with a Redis store when you need it.
- **Refresh-token rotation / revocation** — currently stateless (see Auth model above).
- **i18n** — not set up.
- **Real domain models for a dating site** (profiles, matches, messages, swipes) — only the generic `User` scaffold exists. These are the first real modules to add.
- **CI pipeline** — add `.github/workflows/` with lint + test + build on PR.

---

## 13. Suggested next steps

1. **Fill in `.env` with real Supabase credentials** and generate the first migration (`npm run migration:generate -- src/database/migrations/Init`).
2. **Model the dating domain.** Likely modules to add: `profiles`, `photos`, `preferences`, `swipes`, `matches`, `messages`. Each gets its own module folder under `src/modules/`.
3. **Decide on auth direction.** Keep the current self-managed JWT flow, or delegate to Supabase Auth (in which case you'd replace `AuthModule`'s issuance logic with Supabase JWT verification and probably drop bcrypt). Worth deciding early.
4. **Add refresh-token rotation** once you need proper session revocation — a `refresh_tokens` table keyed by user + device.
5. **Add a CI workflow** (lint + type-check + test + build).
6. **Harden rate limiting** per-route if needed (e.g. stricter limits on `/auth/login`).
7. **Write e2e tests** under `test/` with a disposable schema.
