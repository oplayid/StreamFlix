# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./ 
RUN npm install

# Copy seluruh source code
COPY . .

# Build aplikasi (hasilnya akan masuk ke .vercel/output)
RUN npm run build

# Stage 2: Production Run
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy hasil build dari folder .vercel/output
COPY --from=builder /app/.vercel/output ./.vercel/output
COPY --from=builder /app/package.json ./

EXPOSE 3000

# Jalankan server menggunakan handler/serverless entrypoint dari Vercel output
CMD ["node", ".vercel/output/functions/__server.func/index.mjs"]