export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export interface ProviderIdentityPort {
  resolve(claimedProviderId: string): string;
}
