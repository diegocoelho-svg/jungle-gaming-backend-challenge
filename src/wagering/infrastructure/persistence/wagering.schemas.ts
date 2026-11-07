import { InboxMessageEntitySchema } from "./schemas/inbox-message.schema";
import { OutboxMessageEntitySchema } from "./schemas/outbox-message.schema";
import { WagerTransactionEntitySchema } from "./schemas/wager-transaction.schema";
import { WalletLedgerEntryEntitySchema } from "./schemas/wallet-ledger-entry.schema";
import { WalletEntitySchema } from "./schemas/wallet.schema";

export const WAGERING_SCHEMAS = [
  WalletEntitySchema,
  WagerTransactionEntitySchema,
  WalletLedgerEntryEntitySchema,
  InboxMessageEntitySchema,
  OutboxMessageEntitySchema,
];
