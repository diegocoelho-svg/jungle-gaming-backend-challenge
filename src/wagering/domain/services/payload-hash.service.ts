import { createHash } from "node:crypto";
import type { MoneyProps } from "../value-objects/money.vo";

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);

    return `{${fields.join(",")}}`;
  }

  return JSON.stringify(value);
}

export function computePayloadHash(payload: WagerPayload): string {
  const businessFields: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };

  return createHash("sha256").update(canonicalJson(businessFields)).digest("hex");
}
