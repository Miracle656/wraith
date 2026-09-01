# ── Stage 1: Install all deps + build TypeScript ─────────────────────────────
FROM node:20-alpine AS builder

# Prisma's engines need OpenSSL on Alpine (musl); without it engine loading
# fails with "Error loading shared library" / libssl detection warnings.
RUN apk add --no-cache openssl

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npm run db:generate
COPY . .
RUN npm run build

# ── Stage 2: Production-only image ────────────────────────────────────────────
FROM node:20-alpine AS runner

# OpenSSL for the Prisma query/schema engines at runtime (see builder stage).
RUN apk add --no-cache openssl

WORKDIR /app

# The app runs Prisma schema sync on startup, so the runtime image needs the
# Prisma CLI available without downloading it via npx at container boot.
COPY package*.json ./
RUN npm ci

# Copy built output + Prisma schema from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Generate the Prisma client into this stage's node_modules — the fresh `npm ci`
# above installs @prisma/client but not the generated client, so the app crashed
# on boot with "@prisma/client did not initialize yet".
RUN npm run db:generate

CMD ["node", "dist/index.js"]
