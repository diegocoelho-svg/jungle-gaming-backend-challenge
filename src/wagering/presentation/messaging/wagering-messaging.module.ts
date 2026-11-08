import { Module } from "@nestjs/common";
import { WageringModule } from "../../wagering.module";
import { WagerTransactionsConsumer } from "./wager-transactions.consumer";

@Module({
  imports: [WageringModule],
  providers: [WagerTransactionsConsumer],
})
export class WageringMessagingModule {}
