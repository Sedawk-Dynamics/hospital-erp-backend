import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context propagated through async/await (incl. Prisma calls) so
// deep service code can attach the "who + from where" of an action to audit
// logs WITHOUT threading req/ip/userAgent through every function signature.
//
// Populated by requestContext middleware (ip + userAgent) and by the
// authenticate middleware (userId). Any audit writer reads it best-effort;
// a missing context (e.g. a cron job) simply yields undefined fields.

export interface RequestContext {
  userId?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a fresh request-context store. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current request's context, or undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Best-effort mutation of the active store (e.g. authenticate adds userId). */
export function patchRequestContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
