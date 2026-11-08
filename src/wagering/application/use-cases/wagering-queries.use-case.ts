import type { WagerTransaction } from "../../domain/entities/wager-transaction.entity";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import type { Wallet } from "../../domain/entities/wallet.entity";
import { TransactionNotFoundError, WalletNotFoundError } from "../errors/application.error";
import type { WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextAfterVersion: number | undefined;
}

export class WageringQueries {
  constructor(private readonly unitOfWork: WageringUnitOfWork) {}

  getWallet(walletId: string): Promise<Wallet> {
    return this.unitOfWork.read(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
      return wallet;
    });
  }

  listLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    return this.unitOfWork.read(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) throw new WalletNotFoundError(`Wallet ${walletId} not found`);

      const entries = await ledger.listAfterVersion(walletId, afterVersion, limit + 1);
      const page = entries.slice(0, limit);
      const hasMore = entries.length > limit;

      return { entries: page, nextAfterVersion: hasMore ? page.at(-1)?.walletVersion : undefined };
    });
  }

  getTransaction(transactionId: string): Promise<WagerTransaction> {
    return this.unitOfWork.read(async ({ transactions }) => {
      const transaction = await transactions.findById(transactionId);
      if (!transaction) throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
      return transaction;
    });
  }

  getProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.unitOfWork.read(async ({ transactions }) => {
      const transaction = await transactions.findByExternalId(providerId, externalTransactionId);
      if (!transaction) throw new TransactionNotFoundError(`Transaction ${externalTransactionId} not found`);
      return transaction;
    });
  }
}
