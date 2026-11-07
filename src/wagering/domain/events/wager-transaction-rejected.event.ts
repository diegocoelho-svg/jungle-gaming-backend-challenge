import { WagerTransactionStatus, type WagerTransaction } from "../entities/wager-transaction.entity";
import { InvalidTransactionStateError } from "../errors/domain.error";
import type { MoneyProps } from "../value-objects/money.vo";
import { type EventContext, IntegrationEvent } from "./integration-event";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { failureCode } = transaction;

    if (transaction.status !== WagerTransactionStatus.Rejected || !failureCode) {
      throw new InvalidTransactionStateError(`Rejected event from ${transaction.status}`);
    }

    return new WagerTransactionRejected({
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
        failureCode,
      },
    });
  }
}
