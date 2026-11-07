FROM oven/bun:1.4.4 AS base
WORKDIR /app
COPY package.json bun.lock ./

FROM base AS deps
RUN bun install --frozen-lockfile

FROM deps AS test
COPY . .
CMD ["bun", "test"]

FROM base AS runtime
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
CMD ["bun", "src/main.ts"]
