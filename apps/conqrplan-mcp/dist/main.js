"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const conqrplan_core_1 = require("@conqr/conqrplan-core");
const server_1 = require("./server");
/**
 * Standalone entry point.
 *
 * Reads its whole configuration from the environment, validates it before
 * binding a port, and refuses to start on anything missing. A service that
 * starts with half a configuration fails later, per request, in a way that
 * reads like a permissions bug - which costs far more than failing here.
 */
async function main() {
    const logger = (0, server_1.createLogger)(process.env.LOG_LEVEL ?? 'info');
    let config;
    let tenants;
    let inboundSigningKey;
    try {
        config = (0, conqrplan_core_1.loadServiceConfig)();
        tenants = (0, conqrplan_core_1.loadStaticTenants)();
        inboundSigningKey = (process.env.CONQR_MCP_INBOUND_KEY ?? '').trim();
        if (inboundSigningKey.length < 32) {
            throw new conqrplan_core_1.ConfigError('Missing or too-short CONQR_MCP_INBOUND_KEY (client delegation trust material)');
        }
    }
    catch (err) {
        logger.error('startup refused', { reason: err.message });
        process.exitCode = 78; // EX_CONFIG
        return;
    }
    const approved = await tenants.all();
    const app = new server_1.ConqrPlanMcpApp({ config, tenants, inboundSigningKey, logger });
    const server = (0, server_1.createHttpServer)(app);
    await new Promise((resolve) => server.listen(config.deployment.port, resolve));
    logger.info('conqrplan-mcp listening', {
        port: config.deployment.port,
        tools: app.tools.length,
        tenants: approved.length,
        apiBaseUrl: config.deployment.apiBaseUrl,
    });
    const shutdown = (signal) => {
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
