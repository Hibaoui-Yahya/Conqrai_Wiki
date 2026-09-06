import {
  ConfigError,
  loadServiceConfig,
  loadStaticTenants,
} from '@conqr/conqrplan-core';
import { ConqrPlanMcpApp, createHttpServer, createLogger } from './server';

/**
 * Standalone entry point.
 *
 * Reads its whole configuration from the environment, validates it before
 * binding a port, and refuses to start on anything missing. A service that
 * starts with half a configuration fails later, per request, in a way that
 * reads like a permissions bug - which costs far more than failing here.
 */
async function main(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

  let config;
  let tenants;
  let inboundSigningKey: string;
  try {
    config = loadServiceConfig();
    tenants = loadStaticTenants();
    inboundSigningKey = (process.env.CONQR_MCP_INBOUND_KEY ?? '').trim();
    if (inboundSigningKey.length < 32) {
      throw new ConfigError(
        'Missing or too-short CONQR_MCP_INBOUND_KEY (client delegation trust material)',
      );
    }
  } catch (err) {
    logger.error('startup refused', { reason: (err as Error).message });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const approved = await tenants.all();
  const app = new ConqrPlanMcpApp({ config, tenants, inboundSigningKey, logger });
  const server = createHttpServer(app);

  await new Promise<void>((resolve) =>
    server.listen(config.deployment.port, resolve),
  );
  logger.info('conqrplan-mcp listening', {
    port: config.deployment.port,
    tools: app.tools.length,
    tenants: approved.length,
    apiBaseUrl: config.deployment.apiBaseUrl,
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    // Stop accepting, let in-flight calls finish. A tool call that is a
    // ConqrPlan write must not be cut in half by a deploy.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
