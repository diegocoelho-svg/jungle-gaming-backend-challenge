# Wagering Processor

Processes bets, wins, losses, refunds and rollbacks from game providers over HTTP and SQS, keeping every wallet balance equal to its immutable ledger when messages are duplicated, arrive out of order or are processed concurrently by several instances.

Design decisions, trade-offs and limitations are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

Bun 1.x, TypeScript (strict), NestJS, PostgreSQL 17, AWS SQS through MiniStack, MikroORM 7, Docker Compose.

## Running

Requirements: Docker with Compose. Bun is only needed to run commands outside containers.

```bash
docker compose up --build
```

This starts PostgreSQL, MiniStack, runs the migrations, creates the queues and starts three processes from the same image:

| Service | `APP_ROLE` | Exposed on |
|---|---|---|
| `api` | `api` | `http://localhost:3000` (API, `/health/*`, `/metrics`) |
| `consumer` | `consumer` | `http://localhost:9464` (`/metrics`, `/health/live`) |
| `workers` | `workers` | `http://localhost:9465` (`/metrics`, `/health/live`) |

PostgreSQL is on `localhost:5433` and MiniStack on `localhost:4566`.

### Several instances

Every role is stateless, so any of them can be scaled. Give each scaled service a port range:

```bash
API_PORT=3000-3002 CONSUMER_METRICS_PORT=9464-9466 WORKERS_METRICS_PORT=9470-9471   docker compose up --build --scale api=3 --scale consumer=3 --scale workers=2
```

Each process opens up to `DB_POOL_MAX` (10) connections; the total must stay below PostgreSQL `max_connections` (100).

### Quick check

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"<wallet id>","roundId":"round-1","gameId":"game-1","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Sending the second request again returns the same result with `"idempotentReplay": true`.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/wallets` | create a wallet; a positive initial balance is recorded as an `OPENING` ledger entry |
| `GET` | `/wallets/:walletId` | balance and version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger entries, opaque cursor, `limit` 1–200 |
| `POST` | `/wallets/:walletId/reconciliation` | recompute the balance from the ledger and report divergences |
| `POST` | `/wagering/transactions` | submit a transaction; `Idempotency-Key` header required |
| `GET` | `/wagering/transactions/:transactionId` | transaction by internal id |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transaction by provider id |
| `GET` | `/health/live`, `/health/ready` | liveness; readiness checks PostgreSQL and SQS |
| `GET` | `/metrics` | Prometheus metrics |

Status codes and error bodies are described in [ARCHITECTURE.md](ARCHITECTURE.md#10-http-contract).

## Queues

| Queue | Direction |
|---|---|
| `wager-transactions.fifo` | input; `WagerTransactionRequested` messages, `MessageGroupId` = wallet id |
| `wager-transactions-dlq.fifo` | dead letters; messages sent there directly by the consumer carry a `reason` attribute, messages redriven by SQS after 5 receives do not |
| `wagering-events.fifo` | `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` |

## Tests

All integration, concurrency and failure tests use real PostgreSQL and MiniStack. The reference run is inside the test container, which uses its own database (`wagering_test`) and `test-*` queues:

```bash
docker compose --profile test run --rm test bun test
```

To run a suite from the host, start the dependencies and export the variables of the `test` service in `docker-compose.yml` (pointing to `localhost:5433` and `localhost:4566`):

| Command | Scope |
|---|---|
| `bun run test:unit` | domain, parsers, configuration (no dependencies) |
| `bun run test:integration` | API, schema, inbox, consumer, workers, metrics |
| `bun run test:concurrency` | parallel requests, hot wallet, locks |
| `bun run test:failure` | real processes killed with `SIGKILL`, restarts, SQS outage, dropped database connections |

The `SIGTERM` tests rely on POSIX signals and only pass on Linux, which is why the container is the reference.

## Other commands

| Command | |
|---|---|
| `bun run migrate:up` / `bun run migrate:down` | apply or revert migrations |
| `bun run queues:setup` | create the queues |
| `bun run typecheck` | TypeScript |
| `bun run lint` | oxlint |
| `bun run format:check` | Prettier |

## Configuration

| Variable | Default | |
|---|---|---|
| `APP_ROLE` | `api` | `api`, `consumer` or `workers` |
| `PORT` | `3000` | HTTP port of the API |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | connections per process |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | required | SQS credentials (`test` for MiniStack) |
| `SQS_ENDPOINT` | required | SQS endpoint |
| `SQS_WAGER_QUEUE`, `SQS_WAGER_DLQ`, `SQS_EVENTS_QUEUE` | required | queue names |
| `SQS_MAX_RECEIVE_COUNT` | `5` | receives before SQS redrives a message to the DLQ |
| `SQS_VISIBILITY_HEARTBEAT_MS` | `10000` | visibility extension interval, 100–20000 |
| `METRICS_PORT` | unset | metrics and liveness server for `consumer` and `workers` |

See [.env.example](.env.example).
