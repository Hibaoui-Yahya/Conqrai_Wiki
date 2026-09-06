# ConqrPlan MCP service.
#
# An explicit Dockerfile rather than an inferred build, because the outage this
# service caused was a packaging failure: the runtime image did not contain a
# workspace package, and a stale tsconfig.tsbuildinfo let TypeScript report
# success while emitting nothing. A green build that produces no output is the
# failure mode worth designing against, so this file verifies its own artifacts
# before the image is allowed to exist.

FROM node:22-alpine AS base
# No pinned pnpm version here: corepack takes it from the repo's
# packageManager field, so the image cannot drift from what the workspace and
# lockfile were produced with.
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM base AS builder

# The whole workspace: pnpm validates the lockfile against every member and
# needs the patches directory to hash it, so a partial copy cannot install.
COPY . .

RUN pnpm install --frozen-lockfile --filter @conqr/conqrplan-core --filter @conqr/conqrplan-mcp

# Any build info that rode in on the context is removed before compiling.
# Leaving it is what let tsc decide the output was current and emit nothing.
RUN find /app -name "*.tsbuildinfo" -delete \
 && rm -rf packages/conqrplan-core/dist apps/conqrplan-mcp/dist

RUN pnpm --filter @conqr/conqrplan-core run build \
 && pnpm --filter @conqr/conqrplan-mcp run build

# Fail the build here rather than at boot. tsc's exit code is not evidence that
# anything was written.
RUN test -f packages/conqrplan-core/dist/index.js       || (echo "BUILD GUARD: conqrplan-core produced no dist/index.js" && exit 1)
RUN test -f apps/conqrplan-mcp/dist/main.js       || (echo "BUILD GUARD: conqrplan-mcp produced no dist/main.js" && exit 1)

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only what the service actually runs. `pnpm deploy` was tried first and pulled
# the whole hoisted workspace - 133 MB of Hub's dependencies, none of which
# this service imports. A security boundary should not ship another
# application's dependency tree.
COPY --from=builder /app/apps/conqrplan-mcp/dist ./dist

# Install first. npm prunes anything it considers extraneous, so a workspace
# package copied in beforehand is deleted by the very next command - which the
# runtime guard caught.
RUN printf '%s' '{"name":"conqrplan-mcp-runtime","private":true,"dependencies":{"zod":"^3.23.8"}}' > package.json  && npm install --omit=dev --no-audit --no-fund --loglevel=error

COPY --from=builder /app/packages/conqrplan-core/dist ./node_modules/@conqr/conqrplan-core/dist
COPY --from=builder /app/packages/conqrplan-core/package.json ./node_modules/@conqr/conqrplan-core/package.json

# The checks that would have caught the outage, run against the *final* image.
RUN test -f /app/dist/main.js       || (echo "RUNTIME GUARD: entry point missing" && exit 1)
RUN node -e "const c=require('@conqr/conqrplan-core'); if (c.CONQRPLAN_TOOL_NAMES.length !== 17) { console.error('RUNTIME GUARD: expected 17 tools, got '+c.CONQRPLAN_TOOL_NAMES.length); process.exit(1);} console.log('runtime guard: @conqr/conqrplan-core resolves, '+c.CONQRPLAN_TOOL_NAMES.length+' tools')"

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
