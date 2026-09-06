/**
 * XRPL Mainnet (production) configuration tests.
 *
 * The gateway runs the same code on testnet and mainnet, so the only thing
 * standing between "dev server" and "real money" is configuration. These tests
 * pin that boundary down:
 *
 *   - a complete mainnet configuration starts and reports itself as mainnet
 *   - an incomplete or contradictory one throws at startup, not at request time
 *   - the mock facilitator can never gate a mainnet payment
 *   - payment terms stay bound to network / asset / amount / receiver
 *   - /v1/config leaks no key, token or backend URL to the console
 *
 * No real address, credential or key appears here: every value is an obvious
 * placeholder, and nothing in this file talks to a network.
 */
import request from 'supertest';
import { createFacilitator, loadConfig, ServerConfig } from '../src/index';
import {
  assertProductionSafety,
  networkLabel,
  productionWarnings,
} from '../src/mainnet';
import { publicConfig } from '../src/api';
import { createApp } from '../src/server';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import { X_PAYMENT_HEADER, X402Challenge } from '../src/x402';

/** A syntactically valid, obviously fake classic address. */
const RECEIVER = 'rGATEWAYrecvTESTaddress98765432';
/** An https XRPL JSON-RPC endpoint that is not a testnet/devnet host. */
const MAINNET_RPC = 'https://xrpl.example-node.invalid/rpc';
/** The RLUSD issuer on TESTNET (from .env.example) — must be refused on mainnet. */
const TESTNET_RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

/** A complete, valid XRPL Mainnet configuration. */
function mainnetConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return loadConfig({
    environment: 'production',
    network: 'xrpl:0',
    paymentReceiver: RECEIVER,
    paymentAsset: 'XRP',
    rewardDrops: '1000000',
    paymentFacilitator: 'quicknode',
    xrplRpcUrl: MAINNET_RPC,
    logLevel: 'error',
    ...overrides,
  });
}

/** Run createFacilitator and return the thrown message (fails if it did not throw). */
function startupError(config: ServerConfig): string {
  try {
    createFacilitator(config);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the configuration to be rejected, but it was accepted');
}

// --- a valid mainnet configuration -------------------------------------------

describe('mainnet configuration', () => {
  it('accepts a complete mainnet configuration and builds the real verifier', () => {
    const config = mainnetConfig();
    expect(() => assertProductionSafety(config)).not.toThrow();
    expect(createFacilitator(config).name).toBe('quicknode-facilitator');
  });

  it('accepts the hosted T54 mainnet facilitator', () => {
    const config = mainnetConfig({
      paymentFacilitator: 't54',
      t54FacilitatorUrl: 'https://xrpl-facilitator-mainnet.t54.ai',
      xrplRpcUrl: '',
    });
    expect(createFacilitator(config).name).toBe('t54-facilitator');
  });

  it('accepts RLUSD on mainnet when a non-testnet issuer is configured', () => {
    const config = mainnetConfig({
      paymentAsset: 'RLUSD',
      rlusdIssuer: 'rTKNissuerTESTaddress987654321',
      rewardDrops: '0.01',
    });
    expect(() => assertProductionSafety(config)).not.toThrow();
  });

  it('derives the production environment from XRPL_NETWORK alone', () => {
    const saved = { ...process.env };
    try {
      delete process.env.SONPAY_ENV;
      process.env.XRPL_NETWORK = 'xrpl:0';
      expect(loadConfig().environment).toBe('production');
      process.env.XRPL_NETWORK = 'xrpl:1';
      expect(loadConfig().environment).toBe('development');
      delete process.env.XRPL_NETWORK;
      expect(loadConfig().environment).toBe('development'); // testnet default
    } finally {
      process.env = saved;
    }
  });

  it('refuses an unreadable SONPAY_ENV instead of silently running as development', () => {
    const saved = { ...process.env };
    try {
      process.env.SONPAY_ENV = 'prd';
      expect(() => loadConfig()).toThrow(/SONPAY_ENV/);
    } finally {
      process.env = saved;
    }
  });

  it('labels the networks it knows and passes through the ones it does not', () => {
    expect(networkLabel('xrpl:0')).toBe('XRPL Mainnet');
    expect(networkLabel('xrpl:1')).toBe('XRPL Testnet');
    expect(networkLabel('xrpl:99')).toBe('xrpl:99');
  });
});

// --- testnet / mainnet mismatch ----------------------------------------------

describe('testnet / mainnet mismatch', () => {
  it('refuses production on the testnet network', () => {
    const message = startupError(mainnetConfig({ network: 'xrpl:1' }));
    expect(message).toMatch(/XRPL_NETWORK=xrpl:0/);
  });

  it('refuses mainnet declared as development', () => {
    const message = startupError(mainnetConfig({ environment: 'development' }));
    expect(message).toMatch(/SONPAY_ENV=production/);
  });

  it('refuses a testnet RPC endpoint on mainnet', () => {
    const message = startupError(
      mainnetConfig({ xrplRpcUrl: 'https://s.altnet.rippletest.net:51234' })
    );
    expect(message).toMatch(/testnet\/devnet\/local node/);
  });

  it('refuses the T54 testnet facilitator on mainnet', () => {
    const message = startupError(
      mainnetConfig({
        paymentFacilitator: 't54',
        t54FacilitatorUrl: 'https://xrpl-facilitator-testnet.t54.ai',
        xrplRpcUrl: '',
      })
    );
    expect(message).toMatch(/testnet facilitator/);
  });

  it('refuses a mainnet RPC endpoint while the network is testnet', () => {
    const message = startupError(
      loadConfig({
        network: 'xrpl:1',
        paymentReceiver: RECEIVER,
        xrplRpcUrl: 'https://s1.ripple.com:51234',
      })
    );
    expect(message).toMatch(/XRPL Mainnet endpoint but XRPL_NETWORK/);
  });

  it('leaves an ordinary testnet configuration alone', () => {
    const config = loadConfig({
      network: 'xrpl:1',
      paymentReceiver: 'rTESTNETreceiver00000000000',
      xrplRpcUrl: 'https://s.altnet.rippletest.net:51234',
      paymentFacilitator: 'quicknode',
    });
    expect(() => assertProductionSafety(config)).not.toThrow();
    expect(productionWarnings(config)).toEqual([]);
  });
});

// --- missing production configuration ----------------------------------------

describe('missing production configuration', () => {
  it('reports every missing value at once', () => {
    const message = startupError(
      mainnetConfig({ paymentReceiver: '', xrplRpcUrl: '', rewardDrops: '' })
    );
    expect(message).toMatch(/PAYMENT_RECEIVER is required/);
    expect(message).toMatch(/requires XRPL_RPC_URL/);
    expect(message).toMatch(/PAYMENT_REWARD_DROPS is required/);
    expect(message).toMatch(/3 problems/);
  });

  it('refuses a plaintext http RPC endpoint in production', () => {
    const message = startupError(mainnetConfig({ xrplRpcUrl: 'http://xrpl.example.invalid' }));
    expect(message).toMatch(/must be an https:\/\/ URL/);
  });

  it('refuses a zero or non-numeric payment amount', () => {
    expect(startupError(mainnetConfig({ rewardDrops: '0' }))).toMatch(/positive integer/);
    expect(startupError(mainnetConfig({ rewardDrops: '0.5' }))).toMatch(/positive integer/);
  });

  it('warns — but does not fail — when metering is off in production', () => {
    const warnings = productionWarnings(mainnetConfig());
    expect(warnings.join(' ')).toMatch(/usage metering is OFF/);
    expect(() => assertProductionSafety(mainnetConfig())).not.toThrow();
  });
});

// --- the mock facilitator is not a production facilitator ---------------------

describe('mock facilitator in production', () => {
  it('is refused when selected explicitly', () => {
    const message = startupError(mainnetConfig({ paymentFacilitator: 'mock' }));
    expect(message).toMatch(/PAYMENT_FACILITATOR=mock is refused in production/);
  });

  it('is refused as the zero-config default', () => {
    const message = startupError(
      mainnetConfig({ paymentFacilitator: 'mock', xrplRpcUrl: '' })
    );
    expect(message).toMatch(/PAYMENT_FACILITATOR=mock is refused in production/);
  });

  it('does not silently become the real verifier via the legacy auto-selection', () => {
    // On testnet, PAYMENT_FACILITATOR=mock + XRPL_RPC_URL picks QuickNode.
    // On mainnet that implicitness is exactly what must not happen: the
    // operator has to say which facilitator gates the money.
    const config = mainnetConfig({ paymentFacilitator: 'mock', xrplRpcUrl: MAINNET_RPC });
    expect(() => createFacilitator(config)).toThrow(/PAYMENT_FACILITATOR=mock/);
  });

  it('still backs the zero-config testnet default', () => {
    expect(createFacilitator(loadConfig({ paymentReceiver: RECEIVER })).name).toBe(
      'mock-facilitator'
    );
  });
});

// --- receiver ----------------------------------------------------------------

describe('receiver', () => {
  it('refuses a receiver that is not a classic XRPL address', () => {
    expect(startupError(mainnetConfig({ paymentReceiver: 'not-an-address' }))).toMatch(
      /not a classic XRPL address/
    );
  });

  it('refuses an empty receiver', () => {
    expect(startupError(mainnetConfig({ paymentReceiver: '' }))).toMatch(
      /PAYMENT_RECEIVER is required/
    );
  });
});

// --- asset / network ---------------------------------------------------------

describe('asset and network', () => {
  it('refuses an issued currency with no issuer', () => {
    expect(
      startupError(mainnetConfig({ paymentAsset: 'RLUSD', rewardDrops: '0.01' }))
    ).toMatch(/requires RLUSD_ISSUER/);
  });

  it('refuses the testnet RLUSD issuer on mainnet', () => {
    const message = startupError(
      mainnetConfig({
        paymentAsset: 'RLUSD',
        rlusdIssuer: TESTNET_RLUSD_ISSUER,
        rewardDrops: '0.01',
      })
    );
    expect(message).toMatch(/TESTNET RLUSD issuer/);
  });

  it('refuses an asset the ledger verifier cannot check', () => {
    expect(startupError(mainnetConfig({ paymentAsset: 'DOGE' }))).toMatch(/is not supported/);
  });
});

// --- what the server publishes about itself ----------------------------------

describe('GET /v1/config under a mainnet configuration', () => {
  const config = mainnetConfig({
    openmeterUrl: 'https://in.api.konghq.com',
    openmeterApiKey: 'kpat_test_secret_value',
    llmApiKey: 'sk-secret-llm-key',
    nvidiaApiKey: 'nvapi-secret-key',
    t54FacilitatorUrl: 'https://xrpl-facilitator-mainnet.t54.ai',
  });

  it('reports XRPL Mainnet, the XRP asset and the configured facilitator', async () => {
    const app = createApp({
      facilitator: { ...new MockFacilitator(), name: 'quicknode-facilitator' } as never,
      config,
    });
    const res = await request(app).get('/v1/config').expect(200);
    expect(res.body.environment).toBe('production');
    expect(res.body.payment).toMatchObject({
      network: 'xrpl:0',
      networkLabel: 'XRPL Mainnet',
      mainnet: true,
      asset: 'XRP',
      receiver: RECEIVER,
      facilitator: 'quicknode-facilitator',
      live: true,
    });
  });

  it('marks the mock facilitator as not live so the console never calls it real', () => {
    expect(publicConfig(config, 'mock-facilitator').payment.live).toBe(false);
    expect(publicConfig(config, 't54-facilitator').payment.live).toBe(true);
  });

  it('exposes no provider, OpenMeter or facilitator secret', async () => {
    const app = createApp({ facilitator: new MockFacilitator(), config });
    const res = await request(app).get('/v1/config').expect(200);
    const body = JSON.stringify(res.body);
    for (const secret of [
      config.openmeterApiKey,
      config.llmApiKey,
      config.nvidiaApiKey,
      config.openmeterUrl,
      config.t54FacilitatorUrl,
      config.xrplRpcUrl,
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});

// --- payment terms stay bound to the server's own terms ----------------------

describe('payment terms under a mainnet configuration', () => {
  const config = mainnetConfig();

  it('advertises the mainnet terms in the 402 challenge', async () => {
    const app = createApp({ facilitator: new MockFacilitator(), config });
    const res = await request(app).post('/v1/chat').send({ messages: [] }).expect(402);
    const challenge = res.body as X402Challenge;
    expect(challenge.payment.network).toBe('xrpl:0');
    expect(challenge.payment.receiver).toBe(RECEIVER);
    expect(challenge.payment.rewardDrops).toBe('1000000');
  });

  it('refuses payment terms the payer rewrote', async () => {
    const app = createApp({ facilitator: new MockFacilitator(), config });
    const first = await request(app).post('/v1/chat').send({ messages: [] }).expect(402);
    const challenge = first.body as X402Challenge;

    const forged = [
      { ...challenge.payment, receiver: 'rPAYERSwaXXetTESTaddress9876543' }, // receiver mismatch
      { ...challenge.payment, network: 'xrpl:1' }, // network mismatch
      { ...challenge.payment, rewardDrops: '1' }, // amount mismatch
      { ...challenge.payment, asset: 'RLUSD', issuer: 'rTKNissuerTESTaddress987654321' }, // asset mismatch
    ];
    for (const payment of forged) {
      const res = await request(app)
        .post('/v1/chat')
        .set(
          X_PAYMENT_HEADER,
          JSON.stringify({ nonce: challenge.token, signature: 'sig', payment })
        )
        .send({ messages: [] });
      expect(res.status).toBe(402);
      expect(res.body.scheme).toBe('x402');
    }
  });
});
