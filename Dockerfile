# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines VITE_* values into the client bundle at build time.
# Runtime-only secrets (MongoDB, Pocket ID, Web Push private key) are supplied
# to the container by Coolify and must NOT be passed as build arguments.
ARG VITE_TMDB_API_KEY
ARG VITE_SITE_URL
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_WEB_PUSH_PUBLIC_KEY
ENV VITE_TMDB_API_KEY=$VITE_TMDB_API_KEY
ENV VITE_SITE_URL=$VITE_SITE_URL
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
ENV VITE_WEB_PUSH_PUBLIC_KEY=$VITE_WEB_PUSH_PUBLIC_KEY

RUN npm run build

# Stage 2: Production (Nitro node-server output)
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
