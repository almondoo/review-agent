FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache git ca-certificates

ARG GITLEAKS_VERSION=8.21.2
RUN apk add --no-cache --virtual .build-deps curl tar \
 && curl -sSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o /tmp/gl.tgz \
 && tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks \
 && rm /tmp/gl.tgz \
 && chmod +x /usr/local/bin/gitleaks \
 && apk del .build-deps

FROM base AS builder
RUN npm install -g pnpm@10.33.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json biome.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm -r --filter './packages/**' build

FROM base AS runtime
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

RUN addgroup -S agent && adduser -S agent -G agent \
 && chown -R agent:agent /app
USER agent

ENV NODE_ENV=production
ENV REVIEW_AGENT_SANDBOXED=1

CMD ["node", "/app/packages/action/dist/index.js"]
