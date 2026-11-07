import { WagerTransactionStatus, type WagerTransaction } from "../entities/wager-transaction.entity";
import { InvalidTransactionStateError } from "../errors/domain.error";
import { type EventContext, IntegrationEvent } from "./integration-event";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: string;
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`Pending reference event from ${transaction.status}`);
    }

    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      },
    });
  }
}
