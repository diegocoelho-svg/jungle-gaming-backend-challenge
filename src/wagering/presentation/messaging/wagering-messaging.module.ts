import { Module } from "@nestjs/common";
import { WageringModule } from "../../wagering.module";
import { DeadLetterQueueGauge } from "./dead-letter-queue.gauge";
import { WagerTransactionsConsumer } from "./wager-transactions.consumer";

@Module({
  imports: [WageringModule],
  providers: [WagerTransactionsConsumer, DeadLetterQueueGauge],
})
export class WageringMessagingModule {}
