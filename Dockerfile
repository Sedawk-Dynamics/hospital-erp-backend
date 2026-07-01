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
RUN npm run build && npx tsc -p tsconfig.seed.json

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY package.json ./
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]
EXPOSE 4000
# Provision the schema with `db push` (schema-first sync) rather than
# `migrate deploy`: the migration history can't replay cleanly on a fresh DB
# (some tables only ever existed via db push), whereas db push always brings the
# database in sync with schema.prisma and is a no-op once synced. The server
# then seeds all reference data automatically on boot (see src/bootstrap).
# `exec` makes node PID 1 so SIGTERM reaches it for graceful shutdown.
CMD ["sh", "-c", "./node_modules/.bin/prisma db push --skip-generate && exec node dist/server.js"]
