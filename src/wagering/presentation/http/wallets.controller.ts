import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { currentRequestContext } from "../../../core/observability/request-context";
import { WalletNotFoundError } from "../../application/errors/application.error";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { WageringQueries } from "../../application/use-cases/wagering-queries.use-case";
import { encodeLedgerCursor, isUuid, parseLedgerQuery, parseOpenWallet } from "./request-parsers";
import { ledgerEntryResponse, reconciliationResponse, walletResponse } from "./responses";

const assertWalletId = (walletId: string): void => {
  if (!isUuid(walletId)) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
};

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const wallet = await this.openWallet.execute(parseOpenWallet(body), {
      correlationId: currentRequestContext()?.correlationId ?? Bun.randomUUIDv7(),
    });
    return walletResponse(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    assertWalletId(walletId);
    return walletResponse(await this.queries.getWallet(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor: unknown, @Query("limit") limit: unknown) {
    assertWalletId(walletId);
    const query = parseLedgerQuery(cursor, limit);
    const page = await this.queries.listLedger(walletId, query.afterVersion, query.limit);

    return {
      entries: page.entries.map(ledgerEntryResponse),
      nextCursor: page.nextAfterVersion === undefined ? null : encodeLedgerCursor(page.nextAfterVersion),
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param("walletId") walletId: string) {
    assertWalletId(walletId);
    return reconciliationResponse(await this.reconcileWallet.execute(walletId));
  }
}
