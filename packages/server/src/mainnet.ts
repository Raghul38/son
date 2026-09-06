/**
 * Mainnet / production safety rules.
 *
 * Sonpay runs the same code against XRPL Testnet and XRPL Mainnet; the only
 * difference is configuration. That is convenient and dangerous in equal
 * measure, so this module is the one place that decides whether a given
 * configuration is a legitimate production configuration — and refuses to
 * start when it is not.
 *
 * HARD CONSTRAINT (same as config.ts): nothing here hardcodes a mainnet
 * address, a mainnet credential or a private key. The only literal addresses
 * are TESTNET ones, used as a denylist so a testnet leftover can never be
 * accepted as production configuration.
 *
 * The rules are deliberately pure functions of `ServerConfig`: they can be
 * exercised in tests without env vars, and they run at startup — see
 * `createFacilitator()` in src/index.ts, the single choke point every
 * facilitator is built through.
 */
import { ServerConfig, XRPL_MAINNET, XRPL_TESTNET } from './config';

/**
 * RLUSD issuer on XRPL TESTNET (documented in .env.example / README).
 * Listed here only to REJECT it in production: test RLUSD is worthless, and
 * accepting it on mainnet would hand out real answers for free.
 */
const TESTNET_RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

/**
 * Hostname fragments that identify a non-mainnet XRPL endpoint (public
 * testnet/devnet nodes, the T54 testnet facilitator, and anything an operator
 * named "testnet"). Matching one of these in production is a hard error.
 */
const NON_MAINNET_HOST_MARKERS = [
  'testnet',
  'devnet',
  'altnet',
  'rippletest',
  'sidechain',
  'localhost',
  '127.0.0.1',
];

/**
 * Hostnames of well-known XRPL MAINNET public nodes. These are public
 * infrastructure names, not credentials; they exist here so a server that
 * still says `XRPL_NETWORK=xrpl:1` cannot be pointed at the live ledger.
 */
const MAINNET_HOSTS = ['s1.ripple.com', 's2.ripple.com', 'xrplcluster.com'];

/** True for the XRPL Mainnet network id. */
export function isMainnet(network: string): boolean {
  return network === XRPL_MAINNET;
}

/** Human label for a network id — what the console shows. */
export function networkLabel(network: string): string {
  if (network === XRPL_MAINNET) return 'XRPL Mainnet';
  if (network === XRPL_TESTNET) return 'XRPL Testnet';
  return network === '' ? 'unknown network' : network;
}

/** Classic XRPL address shape (base58, "r" prefix). Not a checksum check. */
function isClassicAddress(value: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value);
}

/** Lowercased hostname of a URL, or '' when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function looksNonMainnet(url: string): boolean {
  const lower = url.toLowerCase();
  return NON_MAINNET_HOST_MARKERS.some((marker) => lower.includes(marker));
}

function looksMainnet(url: string): boolean {
  const host = hostOf(url);
  if (host !== '' && MAINNET_HOSTS.includes(host)) return true;
  return url.toLowerCase().includes('mainnet');
}

function requireHttps(url: string, name: string): string | undefined {
  if (!/^https:\/\//i.test(url)) {
    return `${name} must be an https:// URL in production (got "${url}").`;
  }
  return undefined;
}

/** Positive amount check: XRP is integer drops, an IOU is a decimal value. */
function amountProblem(config: ServerConfig): string | undefined {
  const raw = config.rewardDrops.trim();
  if (raw === '') return 'PAYMENT_REWARD_DROPS is required in production.';
  if (config.paymentAsset.toUpperCase() === 'XRP') {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return `PAYMENT_REWARD_DROPS must be a positive integer number of drops for XRP (got "${config.rewardDrops}").`;
    }
    return undefined;
  }
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    return `PAYMENT_REWARD_DROPS must be a positive amount for ${config.paymentAsset} (got "${config.rewardDrops}").`;
  }
  return undefined;
}

/** Assets this server can actually price and verify on the ledger. */
function assetProblem(config: ServerConfig): string | undefined {
  const asset = config.paymentAsset.toUpperCase();
  if (asset === 'XRP') {
    return undefined;
  }
  if (asset !== 'RLUSD' && !/^[0-9A-F]{40}$/.test(asset)) {
    return `PAYMENT_ASSET="${config.paymentAsset}" is not supported — use "XRP", "RLUSD", or a 40-hex currency code.`;
  }
  if (config.rlusdIssuer === '') {
    return `PAYMENT_ASSET=${config.paymentAsset} requires RLUSD_ISSUER (the mainnet issuer whose token you accept).`;
  }
  if (!isClassicAddress(config.rlusdIssuer)) {
    return `RLUSD_ISSUER="${config.rlusdIssuer}" is not a classic XRPL address.`;
  }
  if (config.rlusdIssuer === TESTNET_RLUSD_ISSUER) {
    return 'RLUSD_ISSUER is the XRPL TESTNET RLUSD issuer — mainnet must not accept test RLUSD.';
  }
  return undefined;
}

/** Every production rule, as a list of problems (empty = configuration is sound). */
function productionProblems(config: ServerConfig): string[] {
  const problems: string[] = [];

  // 1. Network. Production is mainnet and nothing else.
  if (!isMainnet(config.network)) {
    problems.push(
      `SONPAY_ENV=production requires XRPL_NETWORK=${XRPL_MAINNET} (XRPL Mainnet), got "${config.network}".`
    );
  }

  // 2. Facilitator. The mock verifies nothing; it can never gate real money.
  if (config.paymentFacilitator === 'mock') {
    problems.push(
      'PAYMENT_FACILITATOR=mock is refused in production: the mock facilitator accepts a ' +
        'signed nonce instead of an on-ledger payment. Set PAYMENT_FACILITATOR=quicknode or t54.'
    );
  } else if (config.paymentFacilitator === 'quicknode') {
    if (config.xrplRpcUrl === '') {
      problems.push('PAYMENT_FACILITATOR=quicknode requires XRPL_RPC_URL (a mainnet XRPL JSON-RPC endpoint).');
    } else {
      const scheme = requireHttps(config.xrplRpcUrl, 'XRPL_RPC_URL');
      if (scheme !== undefined) problems.push(scheme);
      if (looksNonMainnet(config.xrplRpcUrl)) {
        problems.push(
          `XRPL_RPC_URL "${config.xrplRpcUrl}" points at a testnet/devnet/local node, not XRPL Mainnet.`
        );
      }
    }
  } else if (config.paymentFacilitator === 't54') {
    if (config.t54FacilitatorUrl === '') {
      problems.push('PAYMENT_FACILITATOR=t54 requires T54_FACILITATOR_URL (the mainnet facilitator).');
    } else {
      const scheme = requireHttps(config.t54FacilitatorUrl, 'T54_FACILITATOR_URL');
      if (scheme !== undefined) problems.push(scheme);
      if (looksNonMainnet(config.t54FacilitatorUrl)) {
        problems.push(
          `T54_FACILITATOR_URL "${config.t54FacilitatorUrl}" is the testnet facilitator, not the mainnet one.`
        );
      }
    }
  }

  // 3. Receiver. Payments land here; an empty or malformed one is unusable.
  if (config.paymentReceiver === '') {
    problems.push('PAYMENT_RECEIVER is required in production — it is the address that collects payments.');
  } else if (!isClassicAddress(config.paymentReceiver)) {
    problems.push(
      `PAYMENT_RECEIVER="${config.paymentReceiver}" is not a classic XRPL address (base58, starts with "r").`
    );
  }

  // 4. Asset + issuer, and 5. amount.
  const asset = assetProblem(config);
  if (asset !== undefined) problems.push(asset);
  const amount = amountProblem(config);
  if (amount !== undefined) problems.push(amount);

  return problems;
}

/**
 * Fail fast on a missing or inconsistent production configuration.
 *
 * Called from `createFacilitator()`, so every path that builds a facilitator —
 * `createServer()`, `startServer()`, or a direct call — is checked. Throws with
 * every problem listed at once: a half-configured mainnet deployment should
 * take one restart to fix, not six.
 */
export function assertProductionSafety(config: ServerConfig): void {
  const problems =
    config.environment === 'production' ? productionProblems(config) : [];

  // Consistency in the other direction: mainnet configuration must not be
  // running as development, and a testnet server must not be aimed at the
  // live ledger.
  if (config.environment !== 'production' && isMainnet(config.network)) {
    problems.push(
      `XRPL_NETWORK=${XRPL_MAINNET} is XRPL Mainnet but SONPAY_ENV=${config.environment}. ` +
        'Set SONPAY_ENV=production to run against mainnet, or use XRPL_NETWORK=' +
        `${XRPL_TESTNET} for testnet.`
    );
  }
  if (!isMainnet(config.network) && config.xrplRpcUrl !== '' && looksMainnet(config.xrplRpcUrl)) {
    problems.push(
      `XRPL_RPC_URL "${config.xrplRpcUrl}" is an XRPL Mainnet endpoint but XRPL_NETWORK is ` +
        `"${config.network}". A payment verified on the wrong network is not a payment.`
    );
  }

  if (problems.length === 0) return;
  throw new Error(
    `Invalid ${config.environment} configuration (${problems.length} problem${
      problems.length === 1 ? '' : 's'
    }):\n  - ${problems.join('\n  - ')}`
  );
}

/**
 * Non-fatal production advice, logged at startup.
 *
 * These are things an operator almost certainly wants but that must NOT stop
 * the gateway: metering is a reporting concern, and a meter outage taking down
 * a payment gateway would be a worse failure than the missing usage record.
 */
export function productionWarnings(config: ServerConfig): string[] {
  if (config.environment !== 'production') return [];
  const warnings: string[] = [];
  if (config.openmeterUrl === '' || config.openmeterApiKey === '') {
    warnings.push(
      'usage metering is OFF (OPENMETER_URL / OPENMETER_API_KEY unset): requests will be ' +
        'served and priced, but no usage event will be recorded.'
    );
  }
  if (!config.routingSkipUnconfiguredProviders) {
    warnings.push(
      'ROUTING_SKIP_UNCONFIGURED_PROVIDERS=false: a paid mainnet request may be routed to a ' +
        'provider with no credentials and answered by the stub.'
    );
  }
  if (config.llmApiKey === '' && config.nvidiaApiKey === '' && !config.ovhAllowAnonymous && config.ovhApiKey === '') {
    warnings.push('no LLM provider credentials are configured: every paid request will get the stub.');
  }
  return warnings;
}
