import { Injectable } from "@nestjs/common";
import type { ProviderIdentityPort } from "./provider-identity.port";

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  resolve(claimedProviderId: string): string {
    return claimedProviderId;
  }
}
