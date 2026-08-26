# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

RUN addgroup --system --gid 1001 nayori \
  && adduser --system --uid 1001 --ingroup nayori nayori

COPY --from=production-dependencies --chown=nayori:nayori /app/node_modules ./node_modules
COPY --from=builder --chown=nayori:nayori /app/dist ./dist
COPY --chown=nayori:nayori package.json package-lock.json ./
COPY --chown=nayori:nayori migrations ./migrations

USER nayori
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
