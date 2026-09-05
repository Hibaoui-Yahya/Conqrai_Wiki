import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { TransformHttpResponseInterceptor } from './common/interceptors/http-response.interceptor';
import { WsRedisIoAdapter } from './ws/adapter/ws-redis.adapter';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import fastifyIp from 'fastify-ip';
import { InternalLogFilter } from './common/logger/internal-log-filter';
import { NO_WORKSPACE_REQUIRED_URL_PREFIXES } from './common/middlewares/domain-exempt-routes';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      routerOptions: {
        maxParamLength: 1000,
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: true,
      },
    }),
    {
      rawBody: true,
      // captures NestJS internal errors
      logger: new InternalLogFilter(),
      // bufferLogs must be false else pino will fail
      // to log OnApplicationBootstrap logs
      bufferLogs: false,
    },
  );

  app.useLogger(app.get(PinoLogger));

  app.setGlobalPrefix('api', {
    exclude: [
      'robots.txt',
      'share/:shareId/p/:pageSlug',
      'mcp',
      // MCP OAuth: discovery + endpoints must be served at the bare origin.
      '.well-known/oauth-authorization-server',
      '.well-known/oauth-protected-resource',
      '.well-known/oauth-protected-resource/mcp',
      '.well-known/openid-configuration',
      'oauth/register',
      'oauth/authorize',
      'oauth/authorize/consent',
      'oauth/token',
      'oauth/revoke',
    ],
  });

  const reflector = app.get(Reflector);
  const redisIoAdapter = new WsRedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();

  app.useWebSocketAdapter(redisIoAdapter);

  await app.register(fastifyIp);
  await app.register(fastifyMultipart);
  await app.register(fastifyCookie);

  // NOTE: the OAuth token/consent/register endpoints receive
  // `application/x-www-form-urlencoded` bodies (RFC 6749 §4.1.3). We do NOT
  // register a parser for it here — @nestjs/platform-fastify already registers
  // `@fastify/formbody`, which parses that content type into a plain object for
  // `@Body()`. Adding our own throws FST_ERR_CTP_ALREADY_PRESENT and crashes
  // bootstrap.

  app
    .getHttpAdapter()
    .getInstance()
    .decorateReply('setHeader', function (name: string, value: unknown) {
      this.header(name, value);
    })
    .decorateReply('end', function () {
      this.send('');
    })
    .addHook('preHandler', function (req, reply, done) {
      // Don't require a resolved workspaceId for these. Derived, not
      // hand-maintained: a route excluded from DomainMiddleware can never
      // acquire a workspaceId, so omitting it here makes it unreachable.
      const excludedPaths = NO_WORKSPACE_REQUIRED_URL_PREFIXES;

      if (
        req.originalUrl.startsWith('/api') &&
        !excludedPaths.some((path) => req.originalUrl.startsWith(path))
      ) {
        if (!req.raw?.['workspaceId'] && req.originalUrl !== '/api') {
          throw new NotFoundException('Workspace not found');
        }
        done();
      } else {
        done();
      }
    });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      stopAtFirstError: true,
      transform: true,
    }),
  );

  // Lock CORS to the configured app origin (and its subdomains when
  // SUBDOMAIN_HOST is set). The previous wide-open `origin: *` with
  // credentialed cookies allowed any site to ride a logged-in session.
  //
  // Fail-open guard: if APP_URL is missing/unparseable in production we
  // log a loud warning and accept any origin rather than hard-rejecting
  // every browser request. A misconfigured prod that 100%-blocks users is
  // a worse outcome than a misconfigured prod that's permissive — the
  // operator gets a clear log line to fix the env var.
  const corsLogger = new Logger('CORS');
  const rawAppUrl = process.env.APP_URL;
  let allowedOrigin: string | null = null;
  if (rawAppUrl) {
    try {
      allowedOrigin = new URL(rawAppUrl).origin;
    } catch {
      corsLogger.warn(
        `APP_URL is set but unparseable: "${rawAppUrl}". CORS is permissive — fix APP_URL.`,
      );
    }
  } else {
    corsLogger.warn(
      'APP_URL is not set. CORS is permissive — set APP_URL to lock down origins.',
    );
  }
  const subdomainHost = process.env.SUBDOMAIN_HOST;
  // Conqr suite (blueprint §5.2A): sibling product origins (e.g. the Plane web
  // app) may call the credentialed /integrations API. Exact-match allowlist,
  // comma-separated; never a wildcard.
  const extraOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Strict, credentialed CORS for the app API: only the configured origin (and
  // its subdomains) may read cookie-authenticated responses. `cb(null, false)`
  // (not `cb(Error)`) on a disallowed origin: we omit the ACAO header so the
  // browser blocks the cross-origin read, WITHOUT 500-ing the request. CSRF on
  // state-changing calls is separately covered by the SameSite=Lax auth cookie.
  const strictOrigin = (origin: string, cb: (e: Error | null, ok: boolean) => void) => {
    // Same-origin (Postman, curl, server-to-server) requests have no Origin.
    if (!origin) return cb(null, true);
    // Fail-open: no parseable APP_URL → accept any origin.
    if (!allowedOrigin) return cb(null, true);
    if (origin === allowedOrigin) return cb(null, true);
    if (extraOrigins.includes(origin)) return cb(null, true);
    if (subdomainHost) {
      try {
        const host = new URL(origin).host;
        if (host === subdomainHost || host.endsWith('.' + subdomainHost)) {
          return cb(null, true);
        }
      } catch {
        /* fall through */
      }
    }
    return cb(null, false);
  };

  // The OAuth 2.1 discovery/register/token/authorize endpoints and the MCP
  // resource are PUBLIC, cross-origin-by-design resources fetched by
  // third-party clients (ChatGPT/Claude connectors) from their own origin — or
  // from a `null`-origin embedded webview. They use Bearer tokens / top-level
  // navigations, not the session cookie, so the strict credentialed policy must
  // NOT apply: it would 500 every one of their requests. These routes set their
  // own `Access-Control-Allow-Origin: *` (or handle preflight explicitly), so
  // here we simply disable the global CORS layer for them (`origin: false` adds
  // no headers and never rejects). Everything else keeps the strict policy.
  const isPublicCrossOriginPath = (rawUrl: string): boolean => {
    const path = (rawUrl || '').split('?')[0];
    return (
      path.startsWith('/oauth') ||
      path.startsWith('/.well-known') ||
      path === '/mcp' ||
      path.startsWith('/mcp/')
    );
  };

  // @fastify/cors accepts a callback delegator `(req, cb)` for per-request
  // options (verified in its source); NestJS's enableCors type only models the
  // static options object, so cast.
  const corsDelegator = (
    req: any,
    cb: (err: Error | null, opts: any) => void,
  ) => {
    if (isPublicCrossOriginPath(req?.url ?? '')) {
      cb(null, { origin: false });
      return;
    }
    cb(null, { origin: strictOrigin, credentials: true });
  };
  // Pass as `{ delegator }` (not a bare function): avvio would otherwise treat
  // a bare function as an options-factory `(instance) => opts` and crash at
  // boot. `delegator` is @fastify/cors's documented per-request hook property.
  app.enableCors({ delegator: corsDelegator } as any);
  app.useGlobalInterceptors(new TransformHttpResponseInterceptor(reflector));
  app.enableShutdownHooks();

  const logger = new Logger('NestApplication');

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UnhandledRejection, reason: ${reason}`, promise);
  });

  process.on('uncaughtException', (error) => {
    logger.error('UncaughtException:', error);
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host, () => {
    logger.log(
      `Listening on http://127.0.0.1:${port} / ${process.env.APP_URL}`,
    );
  });
}

bootstrap();
