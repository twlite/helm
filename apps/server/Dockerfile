FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json

RUN pnpm install --filter @helm/server... --prod --frozen-lockfile

COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY packages/desktop/src ./packages/desktop/src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["tsx", "apps/server/src/index.ts"]
