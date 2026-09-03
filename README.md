# XRP-Pay Router (SonPay)

Payment-gated AI gateway: a client pays a small fee in **XRP or RLUSD** on the
XRP Ledger (x402-style 402 challenge), and in return gets an AI response from
`POST /v1/chat` routed to the cheapest capable model — currently **DeepSeek**
(real provider when `LLM_API_KEY` is set, deterministic stub otherwise).

The server never signs for a payer. It issues a 402 payment challenge, the
payer pays on-ledger with their own wallet, and the server **verifies the
transaction on the ledger itself** (in-process verifier, fail-closed) before
releasing the response.

## How the payment flow works

```
Client           Server (SonPay)              XRPL ledger            DeepSeek
  |  POST /v1/chat  |                            |                      |
  |---------------->|                            |                      |
  | 402 + x402 challenge {payment: {network,     |                      |
  |   receiver, rewardDrops, nonce, asset,       |                      |
  |   issuer}}       |                            |                      |
  |<----------------|                            |                      |
  |                 |                            |                      |
  | payer submits a Payment tx with the nonce    |                      |
  | hex-encoded in MemoData (or InvoiceID)  ---->|                      |
  |                 |                            |                      |
  |  retry with X-PAYMENT: {txHash, payment}     |                      |
  |---------------->|                            |                      |
  |                 |  verifies tx on ledger:    |                      |
  |                 |  validated, Payment type,  |                      |
  |                 |  destination, amount,      |                      |
  |                 |  network, nonce binding,   |                      |
  |                 |  not a replay              |                      |
  |                 |        <-------------------|                      |
  |                 |  (all pass)                |  POST chat          |
  |                 |----------------------------------------------->|
  | 200 routed response (real DeepSeek or stub)  |                <----|
  |<----------------|                            |                      |
```

The 402 challenge is the x402 `payment` object; the retry must send it back
verbatim as the `payment` field of the `X-PAYMENT` header, together with the
on-ledger `txHash` of the payment transaction.

## Try the 402 flow (mock facilitator — zero config, no funds)

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

With `XRPL_RPC_URL` empty, the server uses a zero-config **mock facilitator**:
no network, no funds, no setup. Set `XRPL_RPC_URL` and everything below to
switch to **real on-ledger verification**.

## Smoke-test on testnet — XRP

1. Create a testnet wallet and fund it with test XRP:
   <https://xrpl.org/resources/dev-tools.html> (generate a wallet, then use the
   "Send XRP" tab or the faucet button — 10,000 test XRP).
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
   Tools "Send" is simple; `xrpl.js` snippet below).
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
// Memo fields are Blobs: hex-encode BOTH MemoType and MemoData, or xrpl.js
// rejects the tx with "BaseTransaction: invalid Memos".
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const prepared = await client.autofill({   // fills Sequence/Fee/LastLedgerSequence
  TransactionType: 'Payment',
  Account: wallet.classicAddress,
  Destination: '<payment.receiver>',
  Amount: '<payment.rewardDrops>',           // drops string, e.g. "1000"
  Memos: [{ Memo: { MemoType: hex('x402'), MemoData: hex('<payment.nonce>') } }],
  // Do NOT set NetworkID: mainnet (0) and testnet (1) have network ids <= 1024,
  // and rippled rejects a tx that carries one — telNETWORK_ID_MAKES_TX_NON_CANONICAL.
});
const res = await client.submitAndWait(wallet.sign(prepared).tx_blob);
console.log(res.result.hash, res.result.meta.TransactionResult); // -> tesSUCCESS
await client.disconnect();
```

## Smoke-test on testnet — RLUSD

The verification path is identical to XRP ("same path, IOU amounts"); the
difference is the *asset*, so the payer needs RLUSD and a **trustline** to the
issuer. The canonical RLUSD issuer used on testnet is
`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` (Ripple's testnet issuer — live on the
testnet ledger). Use **only the issuer you actually accept**; never hardcode it
in code (it comes from `RLUSD_ISSUER`).

1. Set up a payer wallet with **test XRP AND test RLUSD**, and create a
   **trustline** to the RLUSD issuer. The XRPL Dev Tools
   (<https://xrpl.org/resources/dev-tools.html>) provides test XRP; test RLUSD
   is obtained from the issuer's testnet faucet/drop (the Ripple testnet RLUSD
   faucet) and the trustline is created with a `TrustSet` transaction to
   `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` for RLUSD. (Tools with memo support —
   e.g. the `xrpl.js` snippet below — make this easy.)
2. Configure the server (`.env`):
   ```
   XRPL_NETWORK=xrpl:1
   PAYMENT_RECEIVER=<your testnet receiving address>
   XRPL_RPC_URL=https://s.altnet.rippletest.net:51234   # public testnet node
   PAYMENT_ASSET=RLUSD
   RLUSD_ISSUER=rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV      # testnet issuer
   PAYMENT_REWARD_DROPS=0.01                             # 0.01 RLUSD per call
   ```
3. Start the server and call the endpoint:
   ```bash
   curl -s -X POST http://localhost:8080/v1/chat \
     -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
   # -> 402 challenge; payment.asset === "RLUSD", payment.issuer === RLUSD_ISSUER,
   #    payment.rewardDrops === "0.01"
   ```
4. Send a real **RLUSD** Payment tx from the funded wallet to `payment.receiver`
   for **exactly** the amount in `payment.rewardDrops` (e.g. `0.01` — the value
   string must match; the verifier normalizes `1.0` = `1` but `0.01` ≠ `0.1`),
   with the nonce hex-encoded in `MemoData` (RLUSD on testnet uses the
   canonical 40-hex currency code `524C555344...`). `xrpl.js` snippet:
   ```js
   // npm i xrpl  (payer-side only, not a server dependency)
   import { Client, Wallet } from 'xrpl';
   const client = new Client('wss://s.altnet.rippletest.net:51233');
   await client.connect();
   const wallet = Wallet.fromSeed('<payer testnet seed>'); // never commit this
   const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
   const amount = {
     currency: '524C555344000000000000000000000000000000', // RLUSD
     value: '<payment.rewardDrops>',                        // e.g. "0.01"
     issuer: '<RLUSD_ISSUER>',                              // the configured issuer
   };
   const prepared = await client.autofill({  // fills Sequence/Fee/LastLedgerSequence
     TransactionType: 'Payment',
     Account: wallet.classicAddress,
     Destination: '<payment.receiver>',
     Amount: amount,
     // Hex-encode both memo fields; omit NetworkID (see the XRP snippet above).
     Memos: [{ Memo: { MemoType: hex('x402'), MemoData: hex('<payment.nonce>') } }],
   });
   const res = await client.submitAndWait(wallet.sign(prepared).tx_blob);
   console.log(res.result.hash, res.result.meta.TransactionResult); // -> tesSUCCESS
   await client.disconnect();
   ```
5. Retry with the on-ledger tx hash (same curl as the XRP flow):
   ```bash
   curl -s -X POST http://localhost:8080/v1/chat \
     -H 'Content-Type: application/json' \
     -H "X-PAYMENT: {\"txHash\":\"<the-on-ledger-tx-hash>\",\"payment\":<payment-from-the-challenge>}" \
     -d '{"messages":[{"role":"user","content":"hello"}]}' | jq
   ```
   A correct RLUSD payment returns 200; a wrong issuer, wrong currency,
   wrong amount, wrong destination, missing nonce memo, or replay returns a
   fresh 402.

> **Trustline note.** RLUSD is an issued currency (IOU): the *payer* must hold
> a trustline to `RLUSD_ISSUER` before a RLUSD payment will succeed, and the
> *receiver* must also hold a trustline. The verifier checks only the
> on-ledger transaction fields (issuer, currency, amount, destination,
> nonce, network, validated + not a replay).

## Payment verification checklist (QuickNode path — in-process, fail-closed)

For every submitted `X-PAYMENT` the server fetches the transaction from the
XRPL JSON-RPC node (`XRPL_RPC_URL`) and requires ALL of:

0. the payment terms echoed back in `X-PAYMENT` are the ones this server asked
   for — `receiver`/`rewardDrops`/`network`/`asset`/`issuer` must equal the
   configured values, so a payer cannot substitute its own receiver or amount
   (the nonce and expiry are still payer-supplied — see the gap note below)
1. validated ledger entry only — `result.validated === true`
2. `TransactionType === 'Payment'`
3. `Destination ===` challenge receiver (`PAYMENT_RECEIVER`)
4. exact `Amount`: XRP drops string; RLUSD amount object with the configured
   issuer and exact value (`0.01` matches only `0.01`; `1.0` = `1`)
5. network id matches the challenge (`XRPL_NETWORK` → `xrpl:1` = testnet, id 1)
6. nonce binding present and matching — `MemoData` (or `InvoiceID`)
   hex-encodes THIS challenge's nonce
7. challenge not expired (5 minutes)
8. not a replay — the tx hash is accepted once only

Any RPC/network/parse/timeout failure returns `valid: false`
(`facilitator-failure`) — the server NEVER trusts a client-provided payment
status; only ledger data fetched by the server counts.

> **Known gap.** The server does not yet remember the challenges it issued, so
> the `nonce` and `expiresAt` in a submitted `X-PAYMENT` are payer-authored: a
> payer can bind a payment to a nonce of its own choosing and to a longer
> validity window. It still has to pay the configured amount to the configured
> receiver, and each transaction hash is accepted only once — but pre-paying
> and holding a payment is possible. Closing this needs a server-side store of
> issued nonces (tracked with the usage-ledger roadmap item).

## T54 hosted facilitator (optional, opt-in)

`PAYMENT_FACILITATOR=t54` swaps payment verification/settlement to T54's hosted
x402 facilitator (testnet `https://xrpl-facilitator-testnet.t54.ai`, mainnet
`https://xrpl-facilitator-mainnet.t54.ai`) instead of the in-process verifier.
This is the classic x402 merchant flow: the server issues a payment request
(challenge), the payer signs an XRPL `Payment` (binding the challenge's
invoice id via memo or `InvoiceID`), and the server asks T54 to verify
(`POST /verify`) and settle (`POST /settle`) the signed transaction.

- Wire format: x402 v2 — `{ x402Version: 2, accepted: { scheme: "exact",
  network, asset, payTo, amount, maxTimeoutSeconds, extra: { sourceTag,
  invoiceId } }, payload: { signedTxBlob } }` (verified from the T54 docs +
  live hosted-openapi.json, 2026-09-03).
- Both `/verify` and `/settle` are called: `/settle` is what actually lands the
  payment and returns the tx hash (the docs' settlement response carries
  `{ success, transaction, network, payer }`); `/settle` re-runs the
  verification checklist internally and fails closed before submitting a bad
  transaction, so calling it on a verified payment is safe and atomic.
- Fail-closed: any T54 error / non-JSON / timeout / HTTP error returns
  `valid: false` with reason `facilitator-failure` — never a free response.
- Requires `T54_FACILITATOR_URL`; the server fails fast at startup with a clear
  error if it is missing. Do not use this for production without an SLA (T54
  is currently best-effort testnet/mainnet infrastructure).

## Routing (router-core)

Routing runs **after** payment verification and is completely separate from it:
`router-core` is a pure package — no network, no payment, no I/O — so the same
request always routes to the same model.

Two strategies ship, selected with `ROUTING_STRATEGY`:

| Strategy | What it does |
|---|---|
| `cheapest` *(default)* | The original behavior: the cheapest model that has every requested capability and fits `maxCostPer1MTokens`. Ties break by model-table order. |
| `tiered` | Classifies the prompt first (SIMPLE / MEDIUM / COMPLEX / REASONING), then picks the cheapest model that satisfies **both** the caller's constraints and the tier's capability requirements. A prompt asking for a proof cannot land on a chat-only model; a prompt containing code gets a code-capable model. |

Every decision also returns an ordered **fallback chain** (all eligible models,
cheapest first). A 200 response carries an additive `routing` block:

```jsonc
{
  "model": "deepseek-v3",
  "content": "...",
  "routing": {
    "strategy": "tiered",
    "tier": "REASONING",
    "confidence": 0.973,
    "reasoning": "tier=REASONING | score=0.10 | reasoning (prove, step by step, formally)",
    "chain": ["deepseek-v3", "mistral-large-2", "claude-3-5-sonnet", "gpt-4o"],
    "attempts": 1
  }
}
```

Other routing controls:

- `ROUTING_SKIP_UNCONFIGURED_PROVIDERS=true` — never route a **paid** request to
  a provider this server cannot actually call (no adapter or no API key). With
  it off (the default) such a request is answered by the stub, as before; with
  it on and nothing configured the request fails fast with
  `400 NO_ROUTE / no-available-provider`.
- `ROUTING_MAX_ATTEMPTS` (default 2) — how many models of the chain one request
  may try. Only *retryable* provider failures (`LLM_BUSY`, `LLM_TIMEOUT`,
  `LLM_PROVIDER_ERROR`) advance to the next model, and only to a model a real
  adapter can serve — a paying caller is never quietly downgraded to the stub.
  DeepSeek is currently the only adapter, so in practice one attempt happens;
  the chain walk starts mattering as soon as a second adapter lands.

Filters are **hard**: capability, cost ceiling, exclude list, provider
availability, and context capacity each fail the request with their own
`NO_ROUTE` reason (`no-model-matches`, `no-model-under-cost-ceiling`,
`all-models-excluded`, `no-available-provider`, `no-model-with-enough-context`)
rather than silently serving a model that does not meet what was paid for.

The classifier, filters, tier model and strategy registry are adapted from
**ClawRouter** (BlockRunAI/ClawRouter), MIT © 2026 BlockRunAI — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Only routing logic was taken;
SonPay's x402/XRP/RLUSD payment layer and facilitators are unchanged.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the server listens |
| `XRPL_NETWORK` | `xrpl:1` | `xrpl:1` = testnet, `xrpl:0` = mainnet |
| `PAYMENT_RECEIVER` | *(empty)* | Address that collects payments (required for real verification) |
| `PAYMENT_REWARD_DROPS` | `1000000` | Per-request amount: XRP drops when `PAYMENT_ASSET=XRP`, value (e.g. `0.01`) when `PAYMENT_ASSET=RLUSD` |
| `PAYMENT_FACILITATOR` | `mock` | Which payment facilitator: `mock` (default — current zero-config behavior: in-process real verifier when `XRPL_RPC_URL` is set, else in-memory mock), `quicknode` (real on-ledger verification via `XRPL_RPC_URL`), or `t54` (hosted T54 facilitator via `T54_FACILITATOR_URL`) |
| `T54_FACILITATOR_URL` | *(empty)* | Hosted T54 x402 facilitator base URL — required only when `PAYMENT_FACILITATOR=t54` (testnet `https://xrpl-facilitator-testnet.t54.ai`, mainnet `https://xrpl-facilitator-mainnet.t54.ai`) |
| `XRPL_RPC_URL` | *(empty)* | XRPL JSON-RPC endpoint for REAL on-ledger verification (e.g. QuickNode, or testnet `https://s.altnet.rippletest.net:51234`). Used when `PAYMENT_FACILITATOR=quicknode`. Empty + `mock` = zero-config local dev |
| `PAYMENT_ASSET` | `XRP` | `XRP` or `RLUSD` (canonical 40-hex currency code `524C555344...`) |
| `RLUSD_ISSUER` | *(empty)* | RLUSD issuer — required only when `PAYMENT_ASSET=RLUSD` |
| `LLM_API_KEY` | *(empty)* | DeepSeek API key. Empty = stub replies (`stub: true`) |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint base |
| `LLM_TIMEOUT_MS` | `30000` | Deadline for one LLM call |
| `ROUTING_STRATEGY` | `cheapest` | `cheapest` (original behavior) or `tiered` (classify the prompt, then pick the cheapest model that meets the tier) |
| `ROUTING_SKIP_UNCONFIGURED_PROVIDERS` | `false` | Route only to providers this server can actually call (adapter + API key) |
| `ROUTING_MAX_ATTEMPTS` | `2` | Models from the fallback chain one request may try after a retryable provider failure |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

(`XRPL_FACILITATOR_URL` from earlier docs is deprecated: the current design
verifies in-process via `XRPL_RPC_URL`, or via the hosted T54 facilitator when
`PAYMENT_FACILITATOR=t54` is set.)

Never commit your `.env` or any private key — the repo's `.gitignore` already
excludes it.

## Development

```bash
npm test          # build + run all Jest suites across workspaces
npm run build     # builds router-core first, then server (order matters)
```

Tests use injected fakes (mock facilitator, injectable fetch) — nothing touches
the network.

## Roadmap

1. [x] x402 challenge/verify flow (mock facilitator)
2. [x] Deterministic cheapest-capable routing (+ ClawRouter-derived tiered strategy, fallback chains, provider availability)
3. [x] DeepSeek as first real LLM provider
4. [x] Real on-ledger XRP payment verification via XRPL JSON-RPC (no xrpl.js, no hosted facilitator)
5. [x] T54 hosted facilitator as an OPTIONAL second facilitator (PAYMENT_FACILITATOR=t54, verify+settle via T54_FACILITATOR_URL)
6. [~] RLUSD support (same verification path, unit-tested + env-driven flow; live testnet smoke test pending — needs operator testnet RLUSD funds, see "Smoke-test on testnet — RLUSD")
7. [ ] Usage/cost ledger (append-only JSONL per request)
8. [ ] Platform fee/markup on each request

## License

Not yet chosen — a LICENSE file will be added before first public release.
Third-party code included in this repository (currently the MIT-licensed
ClawRouter routing logic) is credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which reproduces its license.
