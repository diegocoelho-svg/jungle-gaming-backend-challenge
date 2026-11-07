import { WagerTransactionStatus, type WagerTransaction } from "../entities/wager-transaction.entity";
import { InvalidTransactionStateError } from "../errors/domain.error";
import type { MoneyProps } from "../value-objects/money.vo";
import { type EventContext, IntegrationEvent } from "./integration-event";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  balance: MoneyProps | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      throw new InvalidTransactionStateError(`Processed event from ${transaction.status}`);
    }

    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: transaction.resultBalance?.toJSON() ?? null,
      },
    });
  }
}
