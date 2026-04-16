# ── Stage 1: Install all deps + build TypeScript ─────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npm run db:generate
COPY . .
RUN npm run build

# ── Stage 2: Production-only image ────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies only (excludes typescript, ts-node-dev, @types/*)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built output + Prisma schema from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Run migrations then start the app
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
