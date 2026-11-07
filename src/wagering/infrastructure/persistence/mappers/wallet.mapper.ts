import { Wallet } from "../../../domain/entities/wallet.entity";
import { Money } from "../../../domain/value-objects/money.vo";
import { WalletSchema } from "../schemas/wallet.schema";

export function walletToDomain(row: WalletSchema): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.rehydrate({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletToSchema(wallet: Wallet, row: WalletSchema = new WalletSchema()): WalletSchema {
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  row.balance = wallet.balance.toJSON().amount;
  row.version = wallet.version;
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;
  return row;
}
