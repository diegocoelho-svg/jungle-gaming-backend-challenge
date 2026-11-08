import { Inject, Injectable } from "@nestjs/common";
import { LOGGER } from "../../../core/core.module";
import type { Logger } from "../../../core/observability/logger";
import { ResolvePendingReferencesUseCase } from "../../application/use-cases/resolve-pending-references.use-case";
import { PollingWorker } from "./polling-worker";

export const PENDING_REFERENCE_BATCH_SIZE = 20;

@Injectable()
export class PendingReferenceWorker extends PollingWorker {
  protected readonly name = "pending-reference";
  protected readonly idleDelayMs = 1_000;

  constructor(
    @Inject(LOGGER) logger: Logger,
    @Inject(ResolvePendingReferencesUseCase) private readonly resolvePending: ResolvePendingReferencesUseCase,
  ) {
    super(logger);
  }

  protected async tick(): Promise<boolean> {
    const { claimed } = await this.resolvePending.resolveDue(PENDING_REFERENCE_BATCH_SIZE);
    return claimed === PENDING_REFERENCE_BATCH_SIZE;
  }
}
