# Sonpay Gateway (XRP-Pay Router)

A payment-gated AI gateway: AI clients **pay per request** on the XRP Ledger (XRP/RLUSD) using the **x402** flow, and get routed to the **cheapest LLM model that can do the job**.

Built for autonomous AI agents — clients that can't sign up for accounts or enter credit cards, but *can* sign transactions.

> Status: work in progress. The payment-gating flow, routing core, DeepSeek
> integration, and **real on-ledger XRP/RLUSD payment verification** (in-process
> XRPL JSON-RPC, no facilitator service) are implemented; RLUSD live-testing,
> the usage ledger, and platform fees are next (see Roadmap).

## How it works (simple version)

```
Client                    POST /v1/chat with { messages, capabilities?, maxCostPer1MTokens? }
   │
   ▼
x402 middleware           No X-PAYMENT header? -> 402 + challenge:
                          who to pay (receiver), how much (drops), one-time nonce
   │
   ▼
Payer signs & submits     An XRPL Payment tx (their own wallet) with the
                          challenge nonce in MemoData; sends the tx hash back
   │
   ▼
Facilitator verifies      QuickNodeFacilitator fetches the tx from the ledger
                          (XRPL JSON-RPC) and checks EVERY field against the
                          challenge: validated, Payment type, destination,
                          exact amount, network id, nonce binding, replay guard
                          (mock verifier remains the zero-config default)
   ▼
Router (router-core)      Picks the cheapest model with the requested capabilities
   │                      e.g. deepseek-v3 ($0.25/1M) beats gpt-4o ($5.00/1M)
   ▼
LLM provider adapter      Real DeepSeek API call (OpenAI-compatible) when LLM_API_KEY is set;
   │                      stub fallback (marked `stub: true`) when not configured
   ▼
Response                  { model, modelProvider, costPer1MTokens, content, usage? }
```

The server **never signs for the payer** — it only issues challenges and verifies submitted payments.

## Repo layout

```
packages/
  router-core/    Pure routing logic: model table + cheapest-capable pick. No I/O, fully unit-tested.
  server/         Express app: x402 middleware, facilitator seam, chat handler, DeepSeek adapter.
.env.example      Copy to .env and fill in — every URL/address/key comes from env vars.
```

## Quick start

Requires **Node.js >= 22**.

```bash
# 1. Install
npm install

# 2. Configure (all settings come from env vars — nothing is hardcoded)
cp .env.example .env
#    Optional: set LLM_API_KEY to your DeepSeek key to get real completions.
#    Without a key the server still runs and answers with stub replies (stub: true).

# 3. Build + test
npm run build
npm test

# 4. Run
npm start --workspace @xrppay/server   # or: node packages/server/dist/index.js
```

### Try the 402 flow

**Zero-config (mock facilitator)** — no network, no funds:

```bash
# 1. Unpaid request -> 402 challenge (who to pay, how much, one-time nonce)
curl -s -X POST http://localhost:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | jq

# 2. Retry with an X-PAYMENT header containing the challenge nonce.
#    Mock facilitator accepts { nonce, signature } for local testing.
curl -s -X POST http://localhost:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -H "X-PAYMENT: {\"nonce\":\"<nonce-from-challenge>\",\"signature\":\"test\"}" \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
```

**Real on-ledger verification (testnet)** — see "Smoke-test on testnet" below.

## Smoke-test on testnet (real XRP payment)

1. Create a testnet wallet and fund it with test XRP:
   <https://xrpl.org/resources/dev-tools.html> (generate a wallet, then use the
   "Send XRP" tab or the faucet button to fund it — 10,000 test XRP).
2. Configure the server (`.env`):
   ```
   XRPL_NETWORK=xrpl:1
   PAYMENT_RECEIVER=<your testnet receiving address>
   XRPL_RPC_URL=https://s.altnet.rippletest.net:51234   # public testnet node
   PAYMENT_ASSET=XRP
   PAYMENT_REWARD_DROPS=1000                             # 0.001 test XRP per call
   ```
3. Start the server, then call the endpoint:
   ```bash
   curl -s -X POST http://localhost:8080/v1/chat \
     -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
   # -> 402 challenge; note `payment.nonce`, `payment.receiver`, `payment.rewardDrops`
   ```
4. Send a real Payment tx from the funded wallet to `payment.receiver` for
   exactly `payment.rewardDrops` drops, adding a memo whose `MemoData` is the
   hex encoding of `payment.nonce` (tools that support memos: XRP Ledger Dev
   Tools "Send" is simple; `xrpl.js` snippet example below).
5. Retry with the on-ledger tx hash:
   ```bash
   curl -s -X POST http://localhost:8080/v1/chat \
     -H 'Content-Type: application/json' \
     -H "X-PAYMENT: {\"txHash\":\"<the-on-ledger-tx-hash>\",\"payment\":<payment-from-the-challenge>}" \
     -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
   ```
   A correct payment returns 200 with the routed model's reply; anything wrong
   (wrong amount, wrong destination, missing/mismatched nonce memo, replay)
   returns a fresh 402. The same payment hash is rejected on replay.

Minimal `xrpl.js` payer snippet (for step 4; run it separately — the server
never signs for the payer):
```js
// npm i xrpl  (payer-side only, not a server dependency)
import { Client, Wallet } from 'xrpl';
const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const wallet = Wallet.fromSeed('<payer testnet seed>'); // never commit this
const memoHex = Buffer.from('<payment.nonce from the challenge>', 'utf8').toString('hex');
await client.submitAndWait(wallet.sign({
  TransactionType: 'Payment',
  Account: wallet.classicAddress,
  Destination: '<payment.receiver>',
  Amount: '<payment.rewardDrops>',           // drops string, e.g. "1000"
  Memos: [{ Memo: { MemoType: 'x402', MemoData: memoHex } }],
  NetworkID: 1,                              // testnet; 0 for mainnet
  Fee: '12',
}));
await client.disconnect();
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the server listens |
| `XRPL_NETWORK` | `xrpl:1` | `xrpl:1` = testnet, `xrpl:0` = mainnet |
| `PAYMENT_RECEIVER` | *(empty)* | Address that collects payments (required for real verification) |
| `PAYMENT_REWARD_DROPS` | `1000000` | Per-request amount: XRP drops when `PAYMENT_ASSET=XRP`, value (e.g. `0.01`) when `PAYMENT_ASSET=RLUSD` |
| `XRPL_RPC_URL` | *(empty)* | XRPL JSON-RPC endpoint for REAL on-ledger verification (e.g. QuickNode, or testnet `https://s.altnet.rippletest.net:51234`). Empty = mock facilitator (zero-config dev default) |
| `PAYMENT_ASSET` | `XRP` | `XRP` or `RLUSD` (canonical 40-hex currency code `524C555344...`) |
| `RLUSD_ISSUER` | *(empty)* | RLUSD issuer — required only when `PAYMENT_ASSET=RLUSD` |
| `LLM_API_KEY` | *(empty)* | DeepSeek API key. Empty = stub replies (`stub: true`) |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint base |
| `LLM_TIMEOUT_MS` | `30000` | Deadline for one LLM call |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

(`XRPL_FACILITATOR_URL` from earlier docs is deprecated: the current design
verifies in-process via `XRPL_RPC_URL` instead of a hosted facilitator.)

Never commit your `.env` or any private key — the repo's `.gitignore` already excludes it.

## Development

```bash
npm test          # build + run all Jest suites across workspaces
npm run build     # builds router-core first, then server (order matters)
```

Tests use injected fakes (mock facilitator, injectable fetch) — nothing touches the network.

## Roadmap

1. [x] x402 challenge/verify flow (mock facilitator)
2. [x] Deterministic cheapest-capable routing
3. [x] DeepSeek as first real LLM provider
4. [x] Real on-ledger XRP payment verification via XRPL JSON-RPC (no xrpl.js, no hosted facilitator)
5. [~] RLUSD support (same verification path, unit-tested; live testnet smoke test pending — see PR)
6. [ ] Usage/cost ledger (append-only JSONL per request)
7. [ ] Platform fee/markup on each request

## License

Not yet chosen — a LICENSE file will be added before first public release.
