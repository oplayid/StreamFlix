# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./ 
RUN npm ci

# Copy seluruh source code
COPY . .

# Build aplikasi (Pastikan Nitro terkonfigurasi ke preset node agar masuk ke .output)
RUN npm run build

# Stage 2: Production Run
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy hasil build dari folder .output Nitro standar
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package.json ./

EXPOSE 3000

# Jalankan server SSR Nitro
CMD ["node", ".output/server/index.mjs"]