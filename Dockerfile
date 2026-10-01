# ── Stage 1: Install all deps + build TypeScript ─────────────────────────────
FROM node:20-alpine AS builder

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

RUN apk add --no-cache openssl

WORKDIR /app

# The app runs Prisma schema sync on startup, so the runtime image needs the
# Prisma CLI available without downloading it via npx at container boot.
COPY package*.json ./
RUN npm ci

# Copy built output + Prisma schema from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# npm ci installs @prisma/client into a fresh node_modules directory in this
# stage, so generate the client here as well as in the builder stage.
RUN npm run db:generate

CMD ["node", "dist/index.js"]
