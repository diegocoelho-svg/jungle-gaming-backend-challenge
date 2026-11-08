import { Module } from "@nestjs/common";
import { WageringModule } from "../../wagering.module";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";

@Module({
  imports: [WageringModule],
  providers: [OutboxPublisherWorker, PendingReferenceWorker],
})
export class WageringWorkersModule {}
