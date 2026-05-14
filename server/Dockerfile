# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY server/package.json ./server/package.json
COPY pnpm-workspace.yaml ./
RUN pnpm install --filter server --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app /app
COPY server ./server
RUN pnpm --filter server run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
RUN pnpm install --filter server --prod --frozen-lockfile
COPY --from=build /app/server/dist /app/server/dist
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
