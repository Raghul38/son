# Sonpay Gateway (XRP-Pay Router)

A payment-gated AI gateway: AI clients **pay per request** on the XRP Ledger (XRP/RLUSD) using the **x402** flow, and get routed to the **cheapest LLM model that can do the job**.

Built for autonomous AI agents — clients that can't sign up for accounts or enter credit cards, but *can* sign transactions.

> Status: work in progress. The payment-gating flow, routing core, and DeepSeek LLM integration are implemented; real on-ledger payment verification, RLUSD, the usage ledger, and platform fees are next (see Roadmap).

## How it works (simple version)

```
Client                    POST /v1/chat with { messages, capabilities?, maxCostPer1MTokens? }
   │
   ▼
x402 middleware           No X-PAYMENT header? -> 402 + challenge:
                          who to pay (receiver), how much (drops), one-time nonce
   │
   ▼
Payer signs               An XRPL payment for the requested amount to the receiver
   │
   ▼
Facilitator verifies      Checks the submitted payment against the challenge
   │                      (today: mock verifier; real XRPL check coming — see Roadmap)
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

```bash
# 1. Unpaid request -> 402 challenge (who to pay, how much, one-time nonce)
curl -s -X POST http://localhost:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | jq

# 2. Retry with an X-PAYMENT header containing the challenge nonce.
#    (Today the mock facilitator accepts { nonce, signature } for local testing.)
curl -s -X POST http://localhost:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -H "X-PAYMENT: {\"nonce\":\"<nonce-from-challenge>\",\"signature\":\"test\"}" \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the server listens |
| `XRPL_FACILITATOR_URL` | *(empty)* | Real XRPL facilitator (not wired yet; mock is used) |
| `XRPL_NETWORK` | `xrpl:1` | `xrpl:1` = testnet, `xrpl:0` = mainnet |
| `PAYMENT_RECEIVER` | *(empty)* | Address that collects payments |
| `PAYMENT_REWARD_DROPS` | `1000000` | Per-request payment in XRP drops (1 XRP = 1,000,000 drops) |
| `LLM_API_KEY` | *(empty)* | DeepSeek API key. Empty = stub replies (`stub: true`) |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint base |
| `LLM_TIMEOUT_MS` | `30000` | Deadline for one LLM call |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

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
4. [ ] Real payment verification via QuickNode XRPL JSON-RPC (no xrpl.js)
5. [ ] RLUSD support (currency option in the challenge)
6. [ ] Usage/cost ledger (append-only JSONL per request)
7. [ ] Platform fee/markup on each request

## License

Not yet chosen — a LICENSE file will be added before first public release.
