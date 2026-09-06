FROM node:22-slim AS base
LABEL org.opencontainers.image.source="https://github.com/Hibaoui-Yahya/Conqrai_Wiki"

RUN npm install -g pnpm@10.4.0

FROM base AS builder

WORKDIR /app

# Suite app-switcher URLs are baked into the client at build time (vite define).
# Railway passes matching service variables in as build args automatically.
ARG PLANE_APP_URL
ARG MEET_APP_URL
ARG SERVICE_APP_URL
ENV PLANE_APP_URL=$PLANE_APP_URL \
    MEET_APP_URL=$MEET_APP_URL \
    SERVICE_APP_URL=$SERVICE_APP_URL

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS installer

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl bash fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json
# The server imports @conqr/conqrplan-core at runtime. Without these the image
# builds and deploys "successfully" and then dies on boot with MODULE_NOT_FOUND
# - which is exactly what happened, so the workspace package has to be shipped
# the same way editor-ext is.
COPY --from=builder /app/packages/conqrplan-core/dist /app/packages/conqrplan-core/dist
COPY --from=builder /app/packages/conqrplan-core/package.json /app/packages/conqrplan-core/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/
COPY --from=builder /app/.npmrc /app/.npmrc

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN chown -R node:node /app

USER node

RUN pnpm install --frozen-lockfile --prod

RUN mkdir -p /app/data/storage

EXPOSE 3000

CMD ["pnpm", "start"]
