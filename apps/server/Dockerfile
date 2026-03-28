FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update -qq && \
	apt-get install -y -qq --no-install-recommends docker.io && \
	apt-get clean && rm -rf /var/lib/apt/lists/*

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

# Run in workspace package context so local binaries (like tsx) resolve reliably.
CMD ["pnpm", "--filter", "@helm/server", "start"]
