# Architecture

How the processor keeps every wallet balance correct when messages are duplicated, arrive out of order or are processed by several instances at once, and why each mechanism was chosen.

**PostgreSQL is the single source of truth.** Uniqueness, immutability, non-negativity and wallet/ledger consistency are enforced by the schema, so no code path can break them. Rules that span several rows (reference matching, funds, single reversal) are decided by the domain while the wallet row is locked.

## Contents

1. [Overview](#1-overview)
2. [Layers and ORM](#2-layers-and-orm)
3. [Money](#3-money)
4. [Idempotency](#4-idempotency)
5. [Concurrency](#5-concurrency)
6. [Transactions and settlement rules](#6-transactions-and-settlement-rules)
7. [Messaging: outbox, inbox, queues](#7-messaging-outbox-inbox-queues)
8. [Database guarantees](#8-database-guarantees)
9. [Reconciliation](#9-reconciliation)
10. [HTTP contract](#10-http-contract)
11. [Authentication](#11-authentication)
12. [Observability](#12-observability)
13. [Testing](#13-testing)
14. [Limitations](#14-limitations)

## 1. Overview

One image, three roles selected by `APP_ROLE`; each boots only the modules it needs.

| Role | Responsibility |
|---|---|
| `api` | wallets, submissions, queries, reconciliation, health, metrics |
| `consumer` | settles messages from `wager-transactions.fifo` |
| `workers` | publishes the outbox to `wagering-events.fifo`; retries `PENDING_REFERENCE` transactions |

HTTP and queue submissions go through the same use case and the same settlement step:

```
HTTP (execute)                                  Queue (executeFromMessage)
lookup by key / external id, no lock            BEGIN
  same payload      -> replay                     claim inbox (consumer, messageId)
  different payload -> 409                          already claimed -> duplicate, stop
BEGIN                                             lookup by key / external id
  SELECT wallet FOR UPDATE                          same payload -> replay
  lookup again                                      different    -> conflict (terminal)
  settleTransaction(...)                          SELECT wallet FOR UPDATE, settle, write
  write transaction, ledger, wallet, outbox       COMMIT, then ack
COMMIT (deferred triggers check wallet = ledger)
unique violation -> retry the unit of work
```

## 2. Layers and ORM

| Layer | Contents | Depends on |
|---|---|---|
| `domain` | `Money`, entities, `settleTransaction`, `computePayloadHash`, events | nothing |
| `application` | use cases, ports (unit of work, publisher, metrics, clock, ids), errors | `domain` |
| `infrastructure` | MikroORM unit of work, schemas, mappers, SQS publisher, Prometheus | inner layers |
| `presentation` | controllers, consumer, workers, zod request schemas, error mapping | inner layers |

- The domain imports no Nest, ORM or decorators; `test/unit/wagering/architecture.test.ts` enforces it.
- Validation has two levels. Zod schemas at the edge check shape: required fields, string types, length, control characters, UUIDs, kinds, and report every problem at once. Business rules live in the creation factories (`WagerTransaction.create`, `Wallet.open`, `Money.from`, which enforces exactly two decimals), so HTTP and the queue share them; `rehydrate` rebuilds stored state.
- A business rejection is an **outcome**, not an exception: `settleTransaction` sets `PROCESSED`, `REJECTED` with a `failureCode`, or `PENDING_REFERENCE`, so a rejection is stored, answered and published like any other result.

**ORM.** MikroORM 7 with `EntitySchema` definitions and explicit mappers, chosen for its Unit of Work, `em.transactional()` and `LockMode`. Decorator entities were avoided to keep persistence out of the domain. Raw SQL (inbox claim, claims with `SKIP LOCKED`, ledger sum) always receives `em.getTransactionContext()`.

## 3. Money

**Integer cents in `bigint`** inside the `Money` value object; decimal strings on the wire (`{ "amount": "10.00", "currency": "BRL" }`); `NUMERIC(20,2)` in the database.

| Alternative | Why not |
|---|---|
| `number` | `0.1 + 0.2 = 0.30000000000000004` |
| `decimal.js` / `big.js` | a dependency with configurable precision for a domain that only adds, subtracts and compares two-decimal amounts; worth it with division, FX or interest |

- Input must match `^(0|[1-9]\d*)\.\d{2}$`; JSON numbers, exponents, signs and padding are rejected, so a provider's value has one interpretation.
- `Money` is immutable, compared by value and refuses mixed currencies. It serializes as `MoneyProps`, which keeps event payloads stable.

## 4. Idempotency

**The key.** The provider sends it in the mandatory `Idempotency-Key` header (`data.idempotencyKey` on the queue), recommended as `{providerId}:{externalTransactionId}`. It is a column of `wager_transactions`, written in the same commit as the outcome:

```sql
unique (provider_id, idempotency_key)
unique (provider_id, external_transaction_id)
```

A stored key therefore always sits next to its outcome. The indexes are the guarantee, even with several instances inserting at the same time.

**Payload hash.** The key says "same operation"; the hash checks the content:

```
payloadHash = sha256_hex(canonicalJson({ providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money: { amount, currency }, referenceExternalTransactionId? }))
```

Only business fields are hashed, so HTTP and queue submissions of one operation match. `canonicalJson` sorts keys recursively and drops `undefined`; `amount` is the normalized string. Implementation: `src/wagering/domain/services/payload-hash.service.ts`.

| Situation | Result |
|---|---|
| new key | settled, `idempotentReplay: false` |
| known key, same hash | stored result unchanged, including the balance at that time (`result_balance`); `idempotentReplay: true` |
| known key, different hash, or known external id under another key | `409 IDEMPOTENCY_CONFLICT` |

**Flow.** A lookup without a lock answers replays without waiting for the wallet; the lookup is repeated under the lock; if two requests still race to the insert, the loser hits `23505` and the unit of work is retried (3 attempts), becoming a replay.

| Alternative | Why not |
|---|---|
| in-memory cache | lost on restart, not shared |
| Redis | a second store that can diverge: key written, commit failed |
| separate idempotency table | duplicates data that needs the same commit anyway |
| SQS FIFO deduplication | 5-minute window, does not cover HTTP |

## 5. Concurrency

**Pessimistic row lock on the wallet** (`SELECT ... FOR UPDATE`); the unit of concurrency is `walletId`.

| Alternative | Why not |
|---|---|
| optimistic locking + bounded retry | on a hot wallet most attempts conflict, and bounded retries fail with funds available |
| conditional update (`WHERE balance >= x`) | reversals depend on the reference, currency, player and round; the rule would move to SQL or exist twice |
| application or distributed lock | does not work across instances, or adds a system with its own failures |

- Requests for one wallet queue inside PostgreSQL and run once; different wallets never wait for each other. Correctness does not depend on the number of instances.
- `SET LOCAL lock_timeout = '2s'`: a wallet held longer answers `503` with `Retry-After: 1` instead of draining the pool. `NOWAIT` fails when a short wait would succeed; advisory locks are not enforced on the row.
- `wallets.version` grows by one per ledger entry; the schema uses it for the ledger chain, not for concurrency.
- Trade-off: a very busy wallet is serialized, which is what a consistent balance requires.

## 6. Transactions and settlement rules

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- `PENDING` exists only in memory; the decision happens in the insert transaction.
- Terminal states are enforced by the domain and by the `wager_transactions_guard` trigger.
- `FAILED` (`INFRASTRUCTURE_FAILURE`) is supported end to end but produced by no path. Transient failures answer `503`, unexpected ones `500`; neither is stored, so an outage never becomes a permanent outcome. A failure is transient only when resending the same request can succeed: connection loss, an unresolvable host, lock timeout, deadlock, serialization. Any SQLSTATE of class `08` counts as connection trouble, including `08P01`, which a NUL byte in the SQL text also produces; text fields and the idempotency key therefore reject control characters before reaching the database, so bad input fails as `400` instead of being retried.

| Kind | Effect |
|---|---|
| `OPENING` | internal credit when a wallet opens with a positive balance |
| `BET` | debit, rejected without funds; cannot carry a reference |
| `WIN` | credit, may reference the `BET` |
| `LOSS` | no movement; amount may be `0.00` |
| `REFUND` | credit reversing a processed `BET`, once |
| `ROLLBACK` | inverse of a processed `BET`, `WIN` or `REFUND`, once |

**Interpretations.**

- A reference must match provider, player, wallet, currency and round. The schema enforces provider and declared id (composite FK); the rest is the domain's `REFERENCE_MISMATCH`.
- A transaction is reversed **once by any kind**. The literal "by the same kind" would let a `BET` receive both a `REFUND` and a `ROLLBACK`.
- The single-reversal check runs under the wallet lock (the reference is in the same wallet), backed by the partial unique index `wager_transactions_single_reversal`.
- A reversal that would go negative is `REVERSAL_INSUFFICIENT_FUNDS`, distinct from `INSUFFICIENT_FUNDS`.
- Reversal amounts must equal the reference; partial reversals are out of scope.

**Out-of-order references (TTL).** A missing reference stores the transaction as `PENDING_REFERENCE` (`202`) without moving money. Rejecting at once would lose a reversal that only arrived early. The worker settles one due row per transaction: `FOR UPDATE SKIP LOCKED` on the row, then the wallet lock (the main path never locks pending rows, so there is no deadlock), a status recheck and the same `settleTransaction`. A worker that dies releases the row at once. Backoff starts at 5 s, doubles up to 5 minutes, for 12 attempts (about 35 minutes): long enough for provider retries and queue redelivery, short enough not to leave a balance waiting. A retry that still finds nothing emits no event; the last attempt rejects with `REFERENCE_NOT_FOUND` and publishes `WagerTransactionRejected`.

| Failure code | Meaning |
|---|---|
| `INSUFFICIENT_FUNDS` | bet above the balance |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversal would go negative |
| `BALANCE_LIMIT_EXCEEDED` | credit above the supported range |
| `CURRENCY_MISMATCH` | currency differs from the wallet |
| `PLAYER_WALLET_MISMATCH` | player does not own the wallet |
| `REFERENCE_MISMATCH` | reference in another player, wallet, currency or round |
| `REFERENCE_INVALID_KIND` | reference kind cannot be reversed by this operation |
| `REFERENCE_AMOUNT_MISMATCH` | reversal amount differs from the reference |
| `REFERENCE_NOT_PROCESSED` | reference exists but was not processed |
| `REFERENCE_ALREADY_REVERSED` | reference already reversed |
| `REFERENCE_NOT_FOUND` | reference never arrived within the retry limit |
| `INFRASTRUCTURE_FAILURE` | non-business failure (`FAILED`) |

## 7. Messaging: outbox, inbox, queues

**Outbox.** Events are rows written in the same transaction as wallet, ledger and transaction; nothing reaches SQS during a request. Publishing before commit could expose a rolled-back operation, publishing after commit loses events on a crash, SQS has no two-phase commit, and CDC is a whole extra service.

The publisher claims up to 50 due rows with `FOR UPDATE SKIP LOCKED`, sends them with `SendMessageBatch` and marks them in the same transaction, so publishers share the work and a dead one releases its rows. A failed send is retried from when the call returned (1 s doubling, capped at 5 minutes), never dropped. Delivery is **at least once**: the FIFO deduplication id is the event id, which drops resends within 5 minutes, and downstream consumers, outside this service, are expected to deduplicate by it. Events: `WagerTransactionProcessed` (also for `LOSS`), `WagerTransactionRejected`, `WagerTransactionPendingReference`, and `WalletBalanceChanged` only when the balance moves, carrying `walletVersion` for ordering. Payloads hold `MoneyProps`, `correlationId` and `causationId`; worker-emitted events use the transaction id for both.

**Inbox.** `inbox_messages (consumer_name, message_id)` stores the business payload hash and is written in the settlement transaction with `ON CONFLICT DO NOTHING`. A failed settlement rolls it back so the message can be redelivered; an idempotency conflict keeps it.

**Queues.** All FIFO, created by `scripts/setup-queues.ts`.

| Queue | Settings |
|---|---|
| `wager-transactions.fifo` | visibility 30 s; redrive after 5 receives; producers group by `walletId` |
| `wager-transactions-dlq.fifo` | dead letters; direct sends carry a `reason` attribute, SQS redrives do not |
| `wagering-events.fifo` | **this project's choice**, the challenge names no destination; group = wallet, dedup = event id |

FIFO ordering and deduplication are optimizations: on the input queue, duplicates, reordering and redelivery are still expected and handled by the inbox and the database.

**Consumer.** It validates the envelope with the HTTP parser, calls `executeFromMessage` and acknowledges **only after the commit**.

| Outcome | Handling |
|---|---|
| settled (including `REJECTED`, `PENDING_REFERENCE`), same-hash redelivery, idempotency conflict | ack |
| reused `messageId` with another payload | DLQ `MESSAGE_ID_REUSED` |
| malformed message, invalid command (e.g. `OPENING`) | DLQ `INVALID_MESSAGE` |
| unknown wallet | DLQ `WALLET_NOT_FOUND` |
| transient or unexpected failure | no ack, visibility `min(300, 2 × 2^(receives − 1))` s, redrive after 5 receives |

- Permanent failures skip the receive limit because retrying cannot fix them.
- Groups in a batch run concurrently, messages of one group in order; on a retry the rest of the group is released.
- While a batch is open, unfinished messages are extended to 30 s every `SQS_VISIBILITY_HEARTBEAT_MS` (10 s; 0.1–20 s allowed). Updates are serialized per message and stop once its outcome is decided, so an extension never overrides a retry delay.
- A crash between commit and ack is absorbed by the inbox: the redelivery is only acknowledged.
- `SIGTERM`: stop polling, let the 3 s long poll return (aborting it lets SQS hand messages to a dead request), finish what is in progress, release the rest with visibility 0.

## 8. Database guarantees

| Guarantee | Mechanism |
|---|---|
| non-negative balance | `CHECK (balance >= 0)` on wallets, ledger and stored results |
| one wallet per player and currency | `UNIQUE (player_id, currency)` |
| idempotency | the two unique indexes in section 4 |
| single reversal | partial unique index `wager_transactions_single_reversal` |
| reference matches its declaration | composite FK |
| append-only ledger | trigger rejects `UPDATE`, `DELETE`, `TRUNCATE` |
| immutable terminal transactions | trigger `wager_transactions_guard` |
| one entry per transaction, gapless versions | unique indexes and the chain trigger |
| balanced entries | `balance_after = balance_before ± amount` |
| wallet equals its ledger | deferred triggers `wallets_match_ledger`, `wallet_ledger_entries_match_wallet` |
| entry matches its transaction | deferred trigger `wallet_ledger_entries_match_transaction` |
| status consistency | checks tying failure code, result balance, timestamps and references to the status |

The consistency triggers and foreign keys are **deferred** to commit, because a wallet and its new entry are only consistent together. Row-local rules run immediately. Migrations are reversible. Deriving the balance from the ledger on every request was rejected: each bet would sum a growing history and would still need a lock.

## 9. Reconciliation

`POST /wallets/:walletId/reconciliation` reads the stored balance and the ledger sum in one `REPEATABLE READ`, read-only transaction. A divergence is reported (`consistent: false`, `difference = stored − calculated`), logged and counted in `wagering_reconciliation_divergences_total`, and never corrected automatically, which would hide its cause.

## 10. HTTP contract

| Outcome | Status | Provider action |
|---|---|---|
| wallet created | `201` | done |
| `PROCESSED` | `200` | done |
| `PENDING_REFERENCE` | `202` | final result follows as an event |
| invalid payload, missing key | `400` | fix the request |
| unknown or malformed id | `404` | check identifiers |
| idempotency conflict, duplicate wallet | `409` | do not resend unchanged |
| `REJECTED` | `422` | business refusal |
| `FAILED` | `500` | system failure |
| lock timeout, deadlock, connection loss | `503` + `Retry-After: 1` | resend with the same key |

Submission outcomes return `{ transactionId, status, balance, failureCode?, idempotentReplay }`; other errors return `{ error, message }`. The ledger cursor is base64url of the last wallet version (`limit` 1–200, default 50).

## 11. Authentication

Not scored by the challenge and not implemented: `AuthGuard` and `ProviderIdentityPort` are pass-through, and replacing them touches neither domain nor use cases. The adopted design:

- **OAuth2 Client Credentials with Keycloak**, since callers are systems. One confidential client per provider in a `wagering` realm; a mapper writes the `provider_id` claim, so it never comes from the caller. Scopes `wagering:write` and `wallets:admin`, audience `wagering-api`, 5-minute tokens.
- `AuthGuard` verifies signature (cached JWKS), `exp`, `iss`, `aud` → `401`. `ScopesGuard` checks the route scope → `403`. A token `provider_id` different from the payload or path is `403`. Authentication runs before the use case, so a refused call consumes no idempotency key. Health and metrics stay public; queue messages are an internal trusted channel still subject to domain validation.
- If Keycloak is down, issued tokens keep working with cached keys; an unknown key id triggers one rate-limited JWKS refresh; a leaked secret is rotated and exposure lasts one token lifetime.
- Rejected: own user table (out of scope), static API keys (no expiry or scopes), mTLS (certificate management per provider).

## 12. Observability

- **Logs:** pino JSON with an allow-list of fields (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, …) and masked decimal values, so a new field cannot leak financial data.
- **Health:** `/health/live` and `/health/ready` (PostgreSQL and SQS, single-flight probes with a 2 s deadline).
- **Metrics:** Prometheus. The API serves `/metrics`; `consumer` and `workers` serve `/metrics` and `/health/live` on `METRICS_PORT`, because otherwise their counters could not be scraped. Every series carries `service` and `role`.

| Metric | Labels | Meaning |
|---|---|---|
| `wagering_transactions_total` | `status`, `source` (`http`, `queue`, `worker`) | settlement outcomes, replays excluded; a pending reference counts again when the worker resolves it |
| `wagering_duplicates_total` | `kind` | idempotent replays, duplicate messages, idempotency conflicts, reused message ids |
| `wagering_retries_total` | `operation` | unique-violation retries, message retries, publication retries, pending-reference reschedules |
| `wagering_dead_letters_total` | `reason` | messages the consumer sent straight to the DLQ |
| `wagering_dead_letter_queue_messages` | | messages in the DLQ, measured on each scrape, including SQS redrives |
| `wagering_lock_conflicts_total` | | lock timeouts and deadlocks |
| `wagering_processing_duration_seconds` | `source` | processing latency histogram |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | | unpublished events and age of the oldest |
| `wagering_reconciliation_divergences_total` | | divergent reconciliations |

Counters are recorded after the commit, so a rolled-back settlement is not counted.

## 13. Testing

Everything except unit tests runs against **real PostgreSQL and MiniStack**.

- **Unit:** `Money`, wallet invariants, settlement rules, currency mismatch, payload hash, parsers, architecture boundaries.
- **Integration:** API contract, schema constraints and triggers, atomicity (a broken outbox rolls back the settlement), inbox and redelivery, consumer (ack after commit, DLQ, retry, redrive, visibility, `SIGTERM` with a message in flight), workers (two publishers, failed and duplicate sends, out-of-order reversals, attempt limit), metrics.
- **Concurrency:** 50 identical requests debit once; balance `100.00` with two simultaneous `80.00` bets ends with one processed, one rejected and `20.00`; hot wallet; independent wallets; lock timeout.
- **Failure** (`bun run test:failure`): real `bun src/main.ts` processes. An SQS proxy in the test holds a chosen call, so `SIGKILL` lands at an exact point.
  - three consumers on a backlog with duplicates settle each operation once;
  - a consumer killed after commit and before `DeleteMessage` causes no second debit;
  - a consumer killed mid-batch is replaced with nothing lost or duplicated;
  - a publisher killed after the send reached SQS and before marking leaves nothing unpublished, each event id delivered once;
  - every process killed under load and restarted: queue drained, pending references resolved, outbox empty, every wallet reconciles;
  - an SQS outage turns readiness down and pauses consumption and publication, which resume without loss;
  - database connections dropped while messages settle are retried, each message settled once.
- **Mutation checks:** each protection (locks, payload comparison, retries, inbox, `SKIP LOCKED`, visibility heartbeat, schema constraints) was removed in turn to confirm a test fails.

## 14. Limitations

- A single hot wallet is bounded by sequential processing on one row.
- Authentication is a placeholder (section 11).
- A `BET` stays `PROCESSED` after a `WIN` and can still be reversed (`BET 10`, `WIN 50`, `REFUND 10` keeps both). The challenge allows it literally; blocking it would be a new reference rule.
- A `WIN` referencing a `BET` is accepted after that `BET` was refunded or rolled back, and several `WIN`s may reference the same `BET`. Rounds with multiple wins are legitimate; rejecting them would need round state the challenge does not define.
- A pending reference that keeps hitting a non-transient error is retried every cycle and logged, never moved to `FAILED`; that would need an error counter on the row.
- Partial reversals and currency conversion are out of scope.
