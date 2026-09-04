FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
RUN apk upgrade --no-cache
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/engine/package.json apps/engine/package.json
RUN npm ci --workspace @openleash/shared --workspace @openleash/client-api
COPY packages/shared packages/shared
COPY apps/engine apps/engine
RUN npm run build -w @openleash/shared && npm run build -w @openleash/client-api
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.source="https://github.com/open-leash/leash" \
      org.opencontainers.image.title="Leash Engine" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/apps/engine/package.json ./apps/engine/package.json
COPY --chown=node:node --from=builder /app/apps/engine/dist ./apps/engine/dist
COPY --chown=node:node --from=builder /app/apps/engine/infra ./apps/engine/infra
USER node
EXPOSE 9318
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENLEASH_API_PORT||9318)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/engine/dist/server.js"]
