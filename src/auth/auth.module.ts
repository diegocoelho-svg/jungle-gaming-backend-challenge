import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { NoopProviderIdentity } from "./noop-provider-identity";
import { PROVIDER_IDENTITY } from "./provider-identity.port";

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
