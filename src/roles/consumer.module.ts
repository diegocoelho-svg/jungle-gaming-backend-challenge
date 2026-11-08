import { Module } from "@nestjs/common";
import { WageringMessagingModule } from "../wagering/presentation/messaging/wagering-messaging.module";

@Module({ imports: [WageringMessagingModule] })
export class ConsumerModule {}
