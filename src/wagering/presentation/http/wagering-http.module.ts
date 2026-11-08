import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "../../../auth/auth.module";
import { WageringModule } from "../../wagering.module";
import { HttpErrorFilter } from "./http-error.filter";
import { WagerTransactionsController } from "./wager-transactions.controller";
import { WalletsController } from "./wallets.controller";

@Module({
  imports: [WageringModule, AuthModule],
  controllers: [WalletsController, WagerTransactionsController],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class WageringHttpModule {}
