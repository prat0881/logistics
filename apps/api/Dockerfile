FROM node:20-alpine
RUN corepack enable
# node:20-alpine ships no `openssl` package, so Prisma's OpenSSL auto-detection
# fails and silently generates an incompatible openssl-1.1.x engine binary
# (this Alpine base only has libssl.so.3). Installing openssl fixes detection.
RUN apk add --no-cache openssl
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @svyft/shared build \
 && pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models \
 && pnpm --filter @svyft/web build \
 && pnpm --filter @svyft/api build \
 && mkdir -p apps/api/client && cp -r apps/web/dist/. apps/api/client/
ENV NODE_ENV=production SERVE_STATIC=true PORT=4000
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
