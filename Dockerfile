# Stage 1: Build (Ganti ke node:22-alpine sesuai kebutuhan package)
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./ 
# Gunakan npm install agar lebih toleran jika ada perbedaan kecil pada lockfile
RUN npm install

# Copy seluruh source code
COPY . .

# Build aplikasi
RUN npm run build

# Stage 2: Production Run
FROM node:22-alpine AS runner

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