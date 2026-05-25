# ── VOID Platform — Dockerfile ────────────────────────────────
FROM node:20-alpine

# Install sharp dependencies
RUN apk add --no-cache vips-dev python3 make g++

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/
COPY .env.production .env

# Create uploads directory
RUN mkdir -p uploads/attachments uploads/avatars uploads/banners uploads/emoji

# Non-root user for security
RUN addgroup -S void && adduser -S void -G void
RUN chown -R void:void /app
USER void

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
