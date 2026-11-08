import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";
import type { EventContext } from "../../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import type { IdGenerator } from "../ports/runtime.port";

export interface CorrelationContext {
  correlationId: string;
  causationId?: string;
}

export interface SettlementEventsInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  entry: WalletLedgerEntry | undefined;
  correlation: CorrelationContext;
  ids: IdGenerator;
  at: Date;
}

export function settlementEvents({
  transaction,
  wallet,
  entry,
  correlation,
  ids,
  at,
}: SettlementEventsInput): OutboxMessage[] {
  const context = (): EventContext => ({ ...correlation, eventId: ids.next(), occurredAt: at });
  const messages: OutboxMessage[] = [];

  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      messages.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context())));
      break;
    case WagerTransactionStatus.Rejected:
      messages.push(OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context())));
      break;
    case WagerTransactionStatus.PendingReference:
      messages.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context())));
      break;
    default:
      break;
  }

  if (entry) {
    messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())));
  }

  return messages;
}
