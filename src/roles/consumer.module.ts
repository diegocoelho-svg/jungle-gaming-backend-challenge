import { BackgroundMetricsModule } from "../metrics/background-metrics.module";
import { Module } from "@nestjs/common";
import { WageringMessagingModule } from "../wagering/presentation/messaging/wagering-messaging.module";

@Module({ imports: [BackgroundMetricsModule, WageringMessagingModule] })
export class ConsumerModule {}
