import {
  DOMAIN_EXEMPT_ROUTES,
  DOMAIN_EXEMPT_URL_PREFIXES,
  NO_WORKSPACE_REQUIRED_URL_PREFIXES,
} from './domain-exempt-routes';

/**
 * The invariant these tests exist for: a route excluded from DomainMiddleware
 * never gets a `workspaceId`, and `main.ts` 404s any `/api` request without
 * one. Excluding a route from the first list and forgetting the second makes
 * it permanently unreachable, which is how the Plane webhook endpoint 404'd
 * every delivery for the life of the integration.
 */
describe('domain-exempt routes', () => {
  it('every domain-exempt route may proceed without a resolved workspace', () => {
    for (const prefix of DOMAIN_EXEMPT_URL_PREFIXES) {
      expect(NO_WORKSPACE_REQUIRED_URL_PREFIXES).toContain(prefix);
    }
  });

  it('the Plane webhook is exempt on both sides', () => {
    expect(DOMAIN_EXEMPT_ROUTES.map((r) => r.path)).toContain(
      'integrations/plane/webhook',
    );
    expect(NO_WORKSPACE_REQUIRED_URL_PREFIXES).toContain(
      '/api/integrations/plane/webhook',
    );
  });

  it('matches the way main.ts tests a request path (startsWith)', () => {
    const url = '/api/integrations/plane/webhook';
    expect(
      NO_WORKSPACE_REQUIRED_URL_PREFIXES.some((p) => url.startsWith(p)),
    ).toBe(true);
  });

  it('does not exempt an ordinary workspace-scoped route', () => {
    const url = '/api/integrations/plane/projects';
    expect(
      NO_WORKSPACE_REQUIRED_URL_PREFIXES.some((p) => url.startsWith(p)),
    ).toBe(false);
  });
});
