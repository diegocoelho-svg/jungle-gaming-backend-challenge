import { type DynamicModule, Module } from "@nestjs/common";
import { ApiModule } from "./roles/api.module";
import { ConsumerModule } from "./roles/consumer.module";
import { CoreModule } from "./core/core.module";
import { WorkersModule } from "./roles/workers.module";
import type { AppRole, Env } from "./core/config/env";

const ROLE_MODULES: Record<AppRole, new () => unknown> = {
  api: ApiModule,
  consumer: ConsumerModule,
  workers: WorkersModule,
};

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(env), ROLE_MODULES[env.appRole]],
    };
  }
}
