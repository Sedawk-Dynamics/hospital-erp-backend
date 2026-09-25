FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.seed.json ./
COPY src ./src
# The generated Prisma surface plus the full ERP service graph can exceed
# Node's default ~2 GB heap during TypeScript compilation in clean CI builds.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build && npx tsc -p tsconfig.seed.json

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
# Document fonts. tsc only emits the .ts it compiles, so these are copied
# straight in — without them every PDF falls back to PDFKit's built-ins, which
# have no glyph for the rupee sign and print amounts with a hole in them.
COPY assets ./assets
COPY package.json ./
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]
EXPOSE 4000
# Provision the schema with `db push` (schema-first sync) rather than
# `migrate deploy`: the migration history can't replay cleanly on a fresh DB
# (some tables only ever existed via db push), whereas db push always brings the
# database in sync with schema.prisma and is a no-op once synced. The server
# then seeds all reference data automatically on boot (see src/bootstrap).
# Deliberately do not pass `--accept-data-loss`. The entrypoint attempts safe
# additive schema synchronization, but a warning or transient sync failure must
# not take the whole API (including /health) offline. It starts against the
# existing schema and logs the failure for explicit maintenance instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "/app/scripts/docker-entrypoint.sh"]
