import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../../auth/provider-identity.port";
import { currentRequestContext } from "../../../core/observability/request-context";
import { TransactionNotFoundError } from "../../application/errors/application.error";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WageringQueries } from "../../application/use-cases/wagering-queries.use-case";
import { isUuid, parseSubmitTransaction } from "./request-parsers";
import { submissionResponse, transactionResponse } from "./responses";

@Controller()
export class WagerTransactionsController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(PROVIDER_IDENTITY) private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseSubmitTransaction(body, idempotencyKey);
    command.providerId = this.providerIdentity.resolve(command.providerId);

    const context = currentRequestContext();
    if (context) Object.assign(context, { providerId: command.providerId, walletId: command.walletId });

    const outcome = await this.processTransaction.execute(command, {
      correlationId: context?.correlationId ?? Bun.randomUUIDv7(),
    });
    const { statusCode, body: reply } = submissionResponse(outcome);

    res.status(statusCode);
    return reply;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    if (!isUuid(transactionId)) throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    return transactionResponse(await this.queries.getTransaction(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const resolvedProvider = this.providerIdentity.resolve(providerId);
    return transactionResponse(await this.queries.getProviderTransaction(resolvedProvider, externalTransactionId));
  }
}
