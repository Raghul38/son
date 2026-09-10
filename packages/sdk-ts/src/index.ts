/**
 * @xrppay/sdk-ts — TypeScript client SDK for the XRP-Pay Router.
 *
 * Public surface: the RouterClient (x402 pay-and-retry chat client), the
 * signing seam, wire types, and typed errors.
 */
export { RouterClient, X_PAYMENT_HEADER, X402_SCHEME, DEFAULT_CHAT_PATH, ROUTER_URL_ENV } from './client';
export type { RouterClientOptions } from './client';
export * from './types';
export * from './signer';
export * from './errors';