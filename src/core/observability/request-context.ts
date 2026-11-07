import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, callback: () => T): T =>
  storage.run(context, callback);

export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
