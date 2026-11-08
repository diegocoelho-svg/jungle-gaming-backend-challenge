import type { EventPublisher } from "../ports/event-publisher.port";
import type { ApplicationLogger, Clock } from "../ports/runtime.port";
import type { WageringUnitOfWork } from "../ports/wagering-unit-of-work.port";

export interface PublishReport {
  claimed: number;
  published: number;
}

export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
  ) {}

  publishDue(limit: number): Promise<PublishReport> {
    return this.unitOfWork.transaction(async (repositories) => {
      const now = this.clock.now();
      const due = await repositories.outbox.claimDue(now, limit);
      if (due.length === 0) return { claimed: 0, published: 0 };

      const published = await this.publisher.publish(due);
      const sentAt = this.clock.now();
      for (const message of due) {
        if (published.has(message.id)) {
          message.markPublished(sentAt);
        } else {
          message.scheduleRetry(sentAt);
          this.logger.warn(
            { context: message.eventType, transactionId: message.aggregateId },
            "event publication failed, retry scheduled",
          );
        }
        repositories.outbox.save(message);
      }

      return { claimed: due.length, published: published.size };
    });
  }
}
