import { Inject, Injectable } from "@nestjs/common";
import { LOGGER } from "../../../core/core.module";
import type { Logger } from "../../../core/observability/logger";
import { PublishOutboxUseCase } from "../../application/use-cases/publish-outbox.use-case";
import { PollingWorker } from "./polling-worker";

const OUTBOX_BATCH_SIZE = 50;

@Injectable()
export class OutboxPublisherWorker extends PollingWorker {
  protected readonly name = "outbox-publisher";
  protected readonly idleDelayMs = 500;

  constructor(
    @Inject(LOGGER) logger: Logger,
    @Inject(PublishOutboxUseCase) private readonly publishOutbox: PublishOutboxUseCase,
  ) {
    super(logger);
  }

  protected async tick(): Promise<boolean> {
    const { claimed } = await this.publishOutbox.publishDue(OUTBOX_BATCH_SIZE);
    return claimed === OUTBOX_BATCH_SIZE;
  }
}
