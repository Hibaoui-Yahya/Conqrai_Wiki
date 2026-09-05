import { RequestMethod } from '@nestjs/common';

/**
 * Routes that run with no workspace context at all.
 *
 * Two separate mechanisms have to agree about these, and for a long time they
 * did not. `CoreModule` skips `DomainMiddleware` for them, which is what
 * leaves `req.raw.workspaceId` unset; the Fastify `preHandler` in `main.ts`
 * then 404s any `/api` request that has no `workspaceId`. A route excluded
 * from the first list but missing from the second is therefore unreachable -
 * it can never satisfy a requirement the first list guaranteed it would fail.
 *
 * That is not a hypothetical: `POST /api/integrations/plane/webhook` was
 * excluded from `DomainMiddleware` and absent from the `main.ts` list, so
 * every ConqrPlan webhook delivery got 404 "Workspace not found" in every
 * deployment the endpoint has ever had. Nothing caught it because a webhook
 * that is never delivered looks exactly like a webhook that was never sent.
 *
 * Both consumers now derive from this one list, so the two cannot drift again.
 */
export const DOMAIN_EXEMPT_ROUTES = [
  { path: 'auth/setup', method: RequestMethod.POST },
  { path: 'health', method: RequestMethod.GET },
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'billing/stripe/webhook', method: RequestMethod.POST },
  // Plane webhook has no workspace/session context — trust is the HMAC.
  { path: 'integrations/plane/webhook', method: RequestMethod.POST },
] as const;

/**
 * The same routes as `/api`-prefixed URL prefixes, for the `main.ts`
 * preHandler that requires a resolved workspace.
 */
export const DOMAIN_EXEMPT_URL_PREFIXES = DOMAIN_EXEMPT_ROUTES.map(
  (route) => `/api/${route.path}`,
);

/**
 * Routes that keep their workspace context but must not be *required* to have
 * resolved one yet - workspace bootstrap and hostname lookup happen before a
 * workspace exists to resolve.
 */
export const WORKSPACE_OPTIONAL_URL_PREFIXES = [
  '/api/workspace/check-hostname',
  '/api/sso/google',
  '/api/workspace/create',
  '/api/workspace/joined',
  '/api/workspace/find-by-email',
];

/** Every `/api` prefix that may proceed without a resolved workspace. */
export const NO_WORKSPACE_REQUIRED_URL_PREFIXES = [
  ...DOMAIN_EXEMPT_URL_PREFIXES,
  ...WORKSPACE_OPTIONAL_URL_PREFIXES,
];
