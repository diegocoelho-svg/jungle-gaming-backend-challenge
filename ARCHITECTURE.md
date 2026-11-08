# Architecture

This document explains how the wagering processor keeps wallet balances correct when messages are duplicated, delivered out of order or processed concurrently by several instances, and why each mechanism was chosen over the alternatives.

The guiding principle is that **PostgreSQL is the single source of truth**. Uniqueness, immutability, non-negativity and wallet/ledger consistency are enforced by the database schema, so no code path can break them. Business rules that depend on several rows (reference matching, insufficient funds, single reversal) are decided by the domain while the wallet row is locked, and the schema backs up the parts it can express.

## Contents

1. [Overview](#1-overview)
2. [Layers](#2-layers)
3. [Money](#3-money)
4. [Idempotency](#4-idempotency)
5. [Concurrency](#5-concurrency)
6. [Transaction lifecycle and settlement rules](#6-transaction-lifecycle-and-settlement-rules)
7. [Atomicity: outbox and inbox](#7-atomicity-outbox-and-inbox)
8. [Database guarantees](#8-database-guarantees)
9. [Reconciliation](#9-reconciliation)
10. [HTTP contract](#10-http-contract)
11. [Authentication](#11-authentication)
12. [Observability](#12-observability)
13. [Testing strategy](#13-testing-strategy)
14. [Current status and limitations](#14-current-status-and-limitations)

---

## 1. Overview

One Docker image runs in three roles, selected by `APP_ROLE`:

| Role | Responsibility | Status |
|---|---|---|
| `api` | HTTP API: wallets, transaction submission, queries, reconciliation, health and metrics | implemented |
| `consumer` | Consumes `wager-transactions.fifo` and settles each message | planned |
| `workers` | Publishes the outbox to `wagering-events.fifo` and retries `PENDING_REFERENCE` transactions | planned |

Each role boots only the Nest modules it needs. HTTP and queue submissions share the same use case (`ProcessWagerTransactionUseCase`) and the same settlement step; they differ only in how duplicates are detected before it.

**HTTP submission** (`execute`):

```
lookup by idempotency key, then by external id (no lock, outside a transaction)
  found, same payload       -> replay the stored result
  found, different payload  -> 409 conflict
BEGIN
  SELECT wallet FOR UPDATE
  lookup again under the lock
  settleTransaction(...)
  write transaction + ledger entry + wallet + outbox events
COMMIT  (deferred triggers validate wallet/ledger consistency)
  unique violation -> retry the whole unit of work (becomes a replay)
```

**Queue message** (`executeFromMessage`, used by the consumer):

```
BEGIN
  claim inbox (consumer_name, message_id)   -- ON CONFLICT DO NOTHING
    already claimed -> duplicate message, nothing else runs
  lookup by idempotency key, then by external id
    found, same payload       -> replay
    found, different payload  -> idempotency conflict (terminal, inbox row kept)
  SELECT wallet FOR UPDATE, lookup again, settle, write  (same as HTTP)
COMMIT
```

After commit, the outbox publisher sends the events to SQS.

## 2. Layers

The code follows Clean Architecture, with dependencies pointing inwards:

| Layer | Contents | May depend on |
|---|---|---|
| `domain` | `Money`, entities, `settleTransaction`, `computePayloadHash`, event types | nothing |
| `application` | Use cases, ports (unit of work, clock, id generator, logger), application errors | `domain` |
| `infrastructure` | MikroORM unit of work, schemas and mappers, database error translation | `application`, `domain` |
| `presentation` | Controllers, request parsers, response mapping, HTTP error filter | `application`, `domain` |

- The domain has **no Nest, ORM or decorator imports**. An architecture test (`test/unit/wagering/architecture.test.ts`) fails if one appears.
- Objects are built through named factories. Factories for new objects validate everything (`WagerTransaction.create`, `Wallet.open`, `Money.from`); `rehydrate` rebuilds an object from stored state without re-running creation rules.
- A business rejection (insufficient funds, reference mismatch) is an **outcome**, not an exception. `settleTransaction` moves the transaction to `PROCESSED`, `REJECTED` (with a `failureCode`) or `PENDING_REFERENCE`, updates the wallet when money moves, and returns the ledger entry to append, if any. A rejection is then stored, answered and published like any other outcome. Exceptions are reserved for conditions that prevent processing (unknown wallet, database unavailable).

**ORM.** MikroORM 7 with `EntitySchema` definitions (`*.schema.ts`) and explicit mappers between schema rows and domain entities. It provides a Unit of Work, an Identity Map, `em.transactional()` and `LockMode.PESSIMISTIC_WRITE`, which are central to this design. Decorator-based entities were avoided so the domain stays free of persistence concerns. Raw SQL statements (inbox claim, ledger sum) are always given `em.getTransactionContext()` so they run inside the current transaction.

## 3. Money

**Decision:** amounts are integer **cents stored in `bigint`** inside the `Money` value object. They travel as decimal strings (`{ "amount": "10.00", "currency": "BRL" }`) and are stored as `NUMERIC(20,2)`.

| Alternative | Why not |
|---|---|
| `number` | Binary floating point cannot represent most decimal fractions (`0.1 + 0.2 = 0.30000000000000004`). |
| `decimal.js` / `big.js` | Correct, but an extra dependency with configurable precision for a domain that only adds, subtracts and compares amounts with two fixed decimals. It would be worth it if division, currency conversion or interest were in scope. |
| Plain strings | No arithmetic. |

- With two fixed decimals, cents are integers and integer addition never rounds.
- Input must match `^(0|[1-9]\d*)\.\d{2}$`: exactly two decimals, no exponent, no leading zeros, no sign, no surrounding spaces. A JSON number is rejected. This removes any ambiguity about how a provider's value is interpreted.
- `Money` is immutable, compared by value, and refuses operations across currencies.
- `bigint` does not serialize to JSON, so `Money` always serializes as `MoneyProps` (decimal string plus currency), which keeps event payloads stable and versionable.
- The database checks ranges and non-negativity; mappers convert string ↔ `bigint` without ever passing through a float.

## 4. Idempotency

### Where the key comes from

The **provider** generates the key and sends it in the mandatory `Idempotency-Key` header (for queue messages, in `data.idempotencyKey`). The recommended format is `{providerId}:{externalTransactionId}`, for example `provider-a:transaction-123`. It means "this is the same operation". A provider that times out waiting for a response resends with the same key, and must get the original result instead of a second debit.

### Where it is stored

The key is a column of the transaction itself, not a separate table or cache:

```sql
constraint wager_transactions_idempotency_key unique (provider_id, idempotency_key),
constraint wager_transactions_external_key    unique (provider_id, external_transaction_id)
```

The key and the settlement outcome are written in the **same commit**; when the outcome moves money, the ledger entry and the new balance are part of that commit too. A stored key therefore always has its final outcome next to it (`PROCESSED`, `REJECTED` or `PENDING_REFERENCE`), never a half-applied debit. The unique indexes are the final guarantee: the database never accepts two rows for the same key or the same external id, even when several instances insert in the same millisecond.

### Payload hash

The key says "same operation"; the payload hash checks that the content is also the same.

```
payloadHash = sha256_hex(canonicalJson({
  providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money: { amount, currency },
  referenceExternalTransactionId          // omitted when absent
}))
```

- Only business fields are included. The header, timestamps and transport metadata are not, so HTTP and queue submissions of the same operation produce the same hash.
- `canonicalJson` sorts object keys recursively, drops `undefined` fields and uses `JSON.stringify` for scalars, so `{"a":1,"b":2}` and `{"b":2,"a":1}` hash identically.
- `money.amount` is the normalized decimal string produced by `Money`.
- The hash is stored as 64 lowercase hex characters (checked by the schema).

Implementation: `src/wagering/domain/services/payload-hash.service.ts`.

### Outcomes

| Situation | Result |
|---|---|
| New key | Settled; response has `idempotentReplay: false` |
| Known key, same hash | Stored result returned unchanged (same `transactionId`, same `balance` observed at that time); `idempotentReplay: true`; the balance is not touched |
| Known key, different hash | `409 IDEMPOTENCY_CONFLICT` |
| Known external id under a different key | `409 IDEMPOTENCY_CONFLICT` |

`idempotentReplay` is computed per response and not stored. It tells the provider that the operation had already been processed and the resend was harmless. The replayed balance comes from `result_balance`, stored with the transaction, because `LOSS` and `REJECTED` outcomes have no ledger entry to read it from.

### HTTP flow

1. **Lookup without a lock** by key, then by external id. A replay is answered immediately and never waits for the wallet lock.
2. **Lock the wallet** and look up again, because another request may have committed while this one waited.
3. Settle and insert.
4. If two requests still race to the insert, one hits a unique index (`23505`). The use case **retries the whole unit of work** (up to 3 attempts). On the retry the other transaction is visible and the request becomes a replay instead of an error.

| Alternative | Why not |
|---|---|
| In-memory cache | Lost on restart and not shared between instances. |
| Redis | A second store that can diverge from PostgreSQL: the key is written, the commit fails, and the key is "used" without a transaction. |
| Separate idempotency table | Duplicates data that already lives in `wager_transactions` and needs the same commit anyway. |
| Check-then-insert only | Two requests both see nothing and both insert. |
| SQS FIFO deduplication | A 5-minute window that does not cover the HTTP API. It is an optimization, not a guarantee. |

## 5. Concurrency

**Decision:** pessimistic row lock on the wallet (`SELECT ... FOR UPDATE`) inside the settlement transaction. The unit of concurrency is `walletId`.

| Alternative | Why not |
|---|---|
| Optimistic locking (`version` + bounded retry) | Works when conflicts are rare. On a hot wallet most attempts conflict and retry, and with a retry limit many fail even though funds were available. |
| Conditional atomic update (`UPDATE ... WHERE balance >= x`) | Fast for a plain debit, but reversals depend on the reference transaction, currency, player and round. The rule would move into SQL or exist twice. |
| Application mutex / distributed lock | A process mutex does not work across instances; a distributed lock is another system with its own failure modes. |
| Global or table lock | Serializes every wallet. |

- Requests for the same wallet queue inside PostgreSQL and each runs once, with no retry storms.
- The business rule stays in the TypeScript domain and always runs against a locked, current balance.
- Correctness does not depend on the number of instances, because the lock lives in the database.
- `wallets.version` starts at 1 (together with the opening ledger entry, when the initial balance is not zero) and grows by exactly one with each further ledger entry. The schema uses it to guarantee the ledger chain, not for concurrency control.

**Lock timeout.** Each transaction runs `SET LOCAL lock_timeout = '2s'`. A wallet held longer than that fails fast with `503` and `Retry-After: 1` instead of exhausting the connection pool. Two seconds absorbs the normal queue of a hot wallet (each settlement takes milliseconds). `NOWAIT` was rejected because it fails even when a short wait would succeed, and advisory locks because nothing forces other code to take them. Since every submission is idempotent, retrying after a `503` is always safe.

**Trade-off.** A very busy wallet is serialized. This is intended: operations on the same balance must be sequential. Different wallets never wait for each other.

## 6. Transaction lifecycle and settlement rules

### States

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- `PENDING` exists only in memory: the decision is taken in the same transaction that inserts the row, so a stored row is always in one of the other states.
- `PROCESSED`, `REJECTED` and `FAILED` are terminal. The domain refuses further transitions, and the `wager_transactions_guard` trigger rejects updates to terminal rows, updates to identity fields and deletes.
- `FAILED` is reserved for the pending-reference worker (a non-business failure while resolving a reference). A recognized transient failure on the request path (lock timeout, deadlock, serialization, connection loss) is answered as `503`, any other unexpected error as `500`, and neither is stored as `FAILED`, so a temporary outage does not become a permanent outcome.

### Kinds

| Kind | Balance effect | Ledger |
|---|---|---|
| `OPENING` | credit (internal, created with the wallet only when the initial balance is not zero) | 1 `CREDIT` |
| `BET` | debit; rejected if funds are insufficient | 1 `DEBIT` |
| `WIN` | credit; may reference the `BET` | 1 `CREDIT` |
| `LOSS` | none | none |
| `REFUND` | credit; reverses a processed `BET` once | 1 `CREDIT` |
| `ROLLBACK` | inverse of the reference; reverses a processed `BET`, `WIN` or `REFUND` once | 1 inverted entry |

Amounts must be greater than zero, except `LOSS`, which accepts `0.00`. `WIN` and `LOSS` may arrive without a reference.

### References and reversals

- A reference is resolved by `(providerId, referenceExternalTransactionId)`. The composite foreign key `wager_transactions_reference_matches_declared` guarantees that the resolved row has the same provider and the declared external id. That it also belongs to the same player, wallet, currency and round is checked by the domain (`REFERENCE_MISMATCH`).
- A reversal amount must equal the reference amount; partial reversals are out of scope.
- A transaction can be reversed **only once, by any reversal kind**. The challenge says "by the same kind of operation", which would allow a `BET` to receive both a `REFUND` and a `ROLLBACK` and be credited twice; the stricter reading was adopted.
- "Already reversed" is checked **while the wallet is locked**. The reference always belongs to the same wallet, so two reversals of the same transaction can never run concurrently and the second always sees the first. The partial unique index `wager_transactions_single_reversal` (unique `reference_transaction_id` for processed `REFUND`/`ROLLBACK`) backs this up in the schema.
- A reversal that would make the balance negative is rejected with `REVERSAL_INSUFFICIENT_FUNDS`, distinct from `INSUFFICIENT_FUNDS`, because the two situations call for different operational responses.
- `OPENING` and the reserved provider `internal` cannot be submitted.

### Out-of-order references

When the reference does not exist yet, the transaction is stored as `PENDING_REFERENCE` (HTTP `202`) without moving the balance, with `next_reference_attempt_at` scheduled. Rejecting immediately would lose a legitimate reversal that simply arrived early, and holding the message in a FIFO queue would block the rest of its group.

The retry worker (planned) claims due rows with `FOR UPDATE SKIP LOCKED` in a short transaction and settles each one in another transaction that locks the wallet first, the same lock order as the main path, to avoid deadlocks. Backoff is exponential from 5 seconds, capped at 5 minutes, for up to 12 attempts (about 35 minutes in total). That window covers normal provider retries and queue redelivery delays, while keeping the player's balance from waiting indefinitely. After the last attempt the transaction becomes `REJECTED` with `REFERENCE_NOT_FOUND` and the corresponding event is published.

### Failure codes

| Code | Meaning |
|---|---|
| `INSUFFICIENT_FUNDS` | Bet larger than the balance |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversal would make the balance negative |
| `BALANCE_LIMIT_EXCEEDED` | Credit would exceed the supported range |
| `CURRENCY_MISMATCH` | Operation currency differs from the wallet currency |
| `PLAYER_WALLET_MISMATCH` | Player does not own the wallet |
| `REFERENCE_MISMATCH` | Reference belongs to another player, wallet, currency or round |
| `REFERENCE_INVALID_KIND` | Reference kind cannot be reversed by this operation |
| `REFERENCE_AMOUNT_MISMATCH` | Reversal amount differs from the reference amount |
| `REFERENCE_NOT_FOUND` | Reference never arrived within the retry limit |
| `REFERENCE_NOT_PROCESSED` | Reference exists but was not processed |
| `REFERENCE_ALREADY_REVERSED` | Reference was already reversed |
| `INFRASTRUCTURE_FAILURE` | Processing failed for a non-business reason (`FAILED`) |

## 7. Atomicity: outbox and inbox

### Outbox

Events are rows in `outbox_messages`, written in the **same transaction** as the wallet, ledger entry and transaction. Either everything is committed or nothing is. Nothing is sent to SQS during a request.

| Alternative | Why not |
|---|---|
| Publish after commit | An event is lost if the process dies between commit and publish. |
| Publish before commit | Consumers may see an operation that is later rolled back. |
| Distributed transaction | SQS does not take part in two-phase commit. |
| CDC (e.g. Debezium) | Robust, but a whole extra service for this scope. |

Events: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` and `WalletBalanceChanged` (whenever there is a ledger entry). Payloads carry `MoneyProps`, never `Money` instances, plus `correlationId` and `causationId`.

The publisher (planned) reads due rows in small batches with `FOR UPDATE SKIP LOCKED`, so several instances share the work without sending the same row at the same time, and a crashed instance releases its rows without a lease to expire. Delivery is **at least once**: a publisher that crashes after sending and before marking the row publishes it again, so consumers deduplicate by event id. Publishing never gives up, because dropping an event loses information; the backoff is capped and outbox lag is exposed as a metric. Ordering between events is not guaranteed, so consumers use `walletVersion`.

### Inbox

Queue messages are recorded in `inbox_messages`, keyed by `(consumer_name, message_id)` and storing the message's payload hash, in the same transaction as the settlement (implemented in `executeFromMessage`):

- `INSERT ... ON CONFLICT DO NOTHING`. If nothing was inserted, the message id was already processed, and the stored payload hash is returned to the caller.
- If settlement fails, the inbox row rolls back with it and the message can be redelivered.
- An idempotency conflict is a terminal outcome: the inbox row is kept so the message is not reprocessed forever.

The consumer (planned) acknowledges a message only after the commit and handles each outcome as follows:

| Outcome | Handling |
|---|---|
| Settled (including `REJECTED` and `PENDING_REFERENCE`) | commit, then ack |
| Same `messageId`, same payload hash | ack (redelivery) |
| Same `messageId`, different payload hash | send to the DLQ: the message id was reused for different content |
| Idempotency conflict | ack, with the inbox row and a metric |
| Malformed message, unknown wallet | send to the DLQ |
| Transient failure | rollback, retry through visibility timeout, DLQ after 5 receives |

A process killed after commit and before the ack receives the message again, finds it in the inbox with the same hash and only acknowledges it. A process killed before commit left nothing behind, and the redelivery is processed normally. `MessageGroupId = walletId` reduces contention per wallet but is not relied on for correctness. On `SIGTERM` the consumer stops receiving, finishes the messages in flight and returns the rest with visibility 0.

## 8. Database guarantees

Invariants live in the schema so that a bug, a manual script or a future migration cannot break them silently.

| Guarantee | Mechanism |
|---|---|
| Non-negative balance | `CHECK (balance >= 0)` on wallets, ledger balances and stored results |
| One wallet per player and currency | `UNIQUE (player_id, currency)` |
| Idempotency | `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Single reversal | partial unique index `wager_transactions_single_reversal` |
| Reference matches its declaration | composite FK on `(reference_transaction_id, provider_id, reference_external_transaction_id)` |
| Append-only ledger | trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `wallet_ledger_entries` |
| Terminal transactions are immutable | trigger `wager_transactions_guard` |
| One ledger entry per transaction, no version gaps | `UNIQUE (wallet_id, transaction_id)`, `UNIQUE (wallet_id, wallet_version)`, chain trigger |
| Balanced entries | `balance_after = balance_before ± amount` check |
| Wallet matches its ledger | deferred constraint triggers `wallets_match_ledger` (on wallet changes) and `wallet_ledger_entries_match_wallet` (on new entries) |
| Ledger entry matches its transaction | deferred constraint trigger `wallet_ledger_entries_match_transaction` |
| Wallet version rules | trigger: starts at 1, grows by exactly one with each balance change, never changes without one |
| Status consistency | checks tying `failure_code`, `result_balance`, `processed_at`, references and retry scheduling to the status |

The three consistency triggers are **deferred** to commit time because the wallet and its new ledger entry are only consistent together; a regular constraint would check the wallet row before the ledger entry exists. Foreign keys are deferred for the same reason. Row-local rules (append-only, chain order, version rules, terminal guard) run immediately. Every migration is reversible (`up` and `down`).

Computing the balance from the ledger on every request was rejected: it removes the stored balance, but each bet would sum an ever-growing history and would still need a lock.

## 9. Reconciliation

`POST /wallets/:walletId/reconciliation` recomputes the balance from the ledger and compares it with the stored balance.

- Both are read in a single `REPEATABLE READ`, read-only transaction, so a concurrent bet cannot make them look different.
- `difference = stored − calculated`.
- A divergence is **reported** (`consistent: false`), **logged** as a warning and **counted** in `wagering_reconciliation_divergences_total`. It is never corrected automatically: an automatic fix would hide the defect that caused it, and could make things worse if the ledger itself were wrong.

## 10. HTTP contract

Each outcome has exactly one status code, so a provider never has to parse an error message to decide whether to resend.

| Outcome | Status | Provider action |
|---|---|---|
| Wallet created | `201` | done |
| `PROCESSED` | `200` | done |
| `PENDING_REFERENCE` | `202` | accepted; final result follows as an event |
| Invalid payload or missing `Idempotency-Key` | `400` | fix the request |
| Unknown wallet or transaction (or malformed id) | `404` | check the identifiers |
| Idempotency conflict, duplicate wallet | `409` | do not resend unchanged |
| `REJECTED` | `422` | business refusal; resending will not change it |
| `FAILED` | `500` | system failure, not a business decision |
| Lock timeout, deadlock, serialization or connection failure | `503` with `Retry-After: 1` | resend with the same key |

Submission outcomes (`200`, `202`, `422`, `500` for a stored `FAILED`) use the submission body:

```json
{ "transactionId": "…", "status": "REJECTED", "balance": { "amount": "70.00", "currency": "BRL" },
  "failureCode": "INSUFFICIENT_FUNDS", "idempotentReplay": false }
```

Errors that prevent processing (`400`, `404`, `409`, `503`, unexpected `500`) use `{ "error": "<CODE>", "message": "..." }`.

Ledger pagination uses an opaque cursor (base64url of the last wallet version) with `limit` between 1 and 200, default 50. Ordering by `wallet_version` is stable because versions are unique and gapless per wallet.

## 11. Authentication

Authentication is not scored by the challenge and is not implemented. The code has the extension points it needs: an `AuthGuard` and a `ProviderIdentityPort`, both pass-through today (the provider comes from the payload). Swapping them changes neither the domain nor the use cases. This is the design that would be adopted.

**Flow.** Callers are provider systems, not people, so the flow is **OAuth2 Client Credentials** with **Keycloak** as the identity provider.

```
Provider ── POST /token (client_id, client_secret) ──► Keycloak
Provider ◄── JWT with provider_id and scopes ──────── Keycloak
Provider ── POST /wagering/transactions (Bearer JWT) ──► API
API: verify signature (cached JWKS), exp, iss, aud
API: check route scope and token provider_id against the payload
     invalid token -> 401   missing scope / other provider -> 403   valid -> use case
```

**Keycloak.** A `wagering` realm with one confidential client per provider and service accounts enabled. A mapper writes the `provider_id` claim, so the value comes from the identity provider and never from the caller. Scopes: `wagering:write` (submit and query) and `wallets:admin` (create wallets, reconcile). Audience `wagering-api`. Tokens live 5 minutes.

**API.**

| Component | Responsibility |
|---|---|
| `AuthGuard` | Verifies signature against the JWKS, expiry, issuer and audience; `401` on failure |
| `ScopesGuard` | Checks the scope required by the route; `403` if missing |
| `ProviderIdentityPort` | Hands the authenticated provider to the use case, so the domain never sees a JWT |

**Rules.** A token `provider_id` different from the payload `providerId` is `403`; otherwise an authenticated provider could act on behalf of another. `GET /providers/:providerId/...` applies the same check. Authentication runs before the use case, so a refused call never stores a transaction or consumes an idempotency key. Health and metrics stay public. Queue messages travel on an internal trusted channel without tokens; the provider identity in a message is still subject to the same domain validation.

**Failure modes.** If Keycloak is down, issued tokens remain valid because the API verifies with cached keys; only new tokens stop. An unknown key id triggers one rate-limited JWKS refresh before refusing, which covers key rotation. A leaked secret is handled by disabling the client and rotating the secret; exposure lasts at most one token lifetime.

| Alternative | Why not |
|---|---|
| Own user table | Out of scope for the challenge |
| Static API keys | No expiry, no standard scopes, manual rotation |
| mTLS | Strong, but requires certificate management per provider |
| Other IdPs (e.g. Zitadel) | Valid and lighter; Keycloak is more widely used |

## 12. Observability

- **Logs:** pino in JSON. Only allow-listed fields are emitted (`correlationId`, `providerId`, `walletId`, `transactionId`, …) and decimal values are masked, so a new field cannot leak data by accident.
- **Correlation:** `correlationId` is taken from the request (or generated) and carried through the use case into outbox events; `causationId` links an event to the message that caused it.
- **Health:** `/health/live` (process) and `/health/ready` (PostgreSQL and SQS, single-flight probes).
- **Metrics:** Prometheus format at `/metrics`, with default process metrics and `wagering_reconciliation_divergences_total`.

## 13. Testing strategy

- **Unit tests** cover the domain (`Money`, settlement rules, payload hash, entities, events, architecture boundaries) and the use-case race paths with a stub unit of work.
- **Integration tests** run against **real PostgreSQL and SQS** (MiniStack). They cover the API, the inbox, the schema constraints and triggers, and atomicity (a broken outbox table must roll back the whole settlement).
- **Concurrency tests** run against the real database:
  - 50 identical requests debit once;
  - the mandatory scenario (balance `100.00`, two simultaneous `80.00` bets) always ends with one processed and one rejected transaction and a balance of `20.00`;
  - a hot wallet never goes negative or loses an update;
  - a locked wallet does not block another one;
  - a lock held past `lock_timeout` answers `503`.
- **Mutation checks:** protections were removed one at a time (wallet lock, payload comparison, unique-violation retry, outbox write, inbox deduplication, schema constraints) to confirm the suite catches each. Every mutation was caught except removing the recheck under the lock, which is covered by the unique indexes plus the retry and only saves a round trip.

## 14. Current status and limitations

Implemented: domain, schema and migrations, HTTP API, settlement with idempotency and locking, inbox claim inside the settlement transaction, outbox writes, reconciliation, health and metrics.

In progress:

- SQS consumer (ack after commit, outcome handling above, retry, DLQ, graceful shutdown on `SIGTERM`);
- outbox publisher and `PENDING_REFERENCE` retry worker;
- failure tests with three or more processes, including a process killed between commit and ack;
- remaining metrics (transactions by status, duplicates, retries, DLQ, lock conflicts, outbox lag, latency).

Known limitations:

- A single hot wallet is bounded by sequential processing on one row. This is inherent to a consistent balance.
- Authentication is a pass-through placeholder (design in section 11).
- A `BET` stays `PROCESSED` after a `WIN`, so it can still be reversed: in `BET 10`, `WIN 50`, `REFUND 10` the player keeps the prize and gets the stake back. The challenge does not cover this case and the literal rules allow it; keeping the sequence coherent is the provider's responsibility. Blocking it would be a new reference rule with its own failure code.
- Partial reversals and currency conversion are out of scope.
