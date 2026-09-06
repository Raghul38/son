# XRP-Pay Router (SonPay)

Payment-gated AI gateway: a client pays a small fee in **XRP or RLUSD** on the
XRP Ledger (x402-style 402 challenge), and in return gets an AI response from
`POST /v1/chat` routed to the cheapest capable model across **DeepSeek**,
**NVIDIA NIM** and **OVHcloud AI Endpoints**, with automatic fallback to the
next provider when one is unavailable (deterministic stub when no provider key
is configured, always flagged `stub: true`).

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
  Raise it when more than one provider is configured, so a failure at one
  provider can be answered by the next.

Filters are **hard**: capability, cost ceiling, exclude list, provider
availability, and context capacity each fail the request with their own
`NO_ROUTE` reason (`no-model-matches`, `no-model-under-cost-ceiling`,
`all-models-excluded`, `no-available-provider`, `no-model-with-enough-context`)
rather than silently serving a model that does not meet what was paid for.

### Models with no published price

`costPer1MTokens` is optional in the model table. Absent means **"the provider
publishes no per-token price"** — it does *not* mean free. NVIDIA's hosted
`build.nvidia.com` endpoints are the real case: rate-limited and free to
evaluate, but NVIDIA quotes no token price and treats production use as
requiring NVIDIA AI Enterprise, so recording `0` would be a false claim.

A router that cannot compare a price must not prefer that model, so an unpriced
model:

- ranks **last** in the chain (after every priced model), and
- is **dropped** by any explicit `maxCostPer1MTokens` — a caller who asked for a
  spend guarantee does not get a model whose cost we cannot show, and
- carries no `costPer1MTokens` field in the response when it does answer.

It is still reachable: as a fallback after a cheaper model fails, or when it is
the only candidate its configured provider offers.

`ModelSpec` also carries an optional `outputCostPer1MTokens` — the provider's
**completion** rate, when it publishes one. Routing never reads it (models are
still ranked by the prompt rate, unchanged); only [cost
accounting](#usage-metering-and-the-platform-fee) does. Absent means the same
thing as above: *no published rate*, never zero and never "same as prompt" —
Qwen3.5 charges 6× more per completion token than per prompt token, so
reusing one rate for the other would invent money nobody quoted.

## Providers

| Provider | Env key | Endpoint | Models registered | Cost basis |
|---|---|---|---|---|
| `deepseek` | `LLM_API_KEY` | `${LLM_BASE_URL}/chat/completions` | `deepseek-v3` (sent as `deepseek-chat`) | published price |
| `nvidia` | `NVIDIA_API_KEY` | `${NVIDIA_BASE_URL}/chat/completions` — default `https://integrate.api.nvidia.com/v1` | `nvidia/llama-3.1-nemotron-70b-instruct`, `meta/llama-3.2-11b-vision-instruct` | **no published price** (see above) |
| `ovhcloud` | `OVH_AI_ENDPOINTS_ACCESS_TOKEN` *(or the anonymous free tier)* | `${OVH_AI_ENDPOINTS_BASE_URL}/chat/completions` — default `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `Qwen3.5-397B-A17B` ($0.71 in / $4.25 out per 1M), `Meta-Llama-3_3-70B-Instruct` ($0.74 in / $0.74 out per 1M) | provider's public catalog |

All three speak the same OpenAI-compatible dialect, so they share one transport
and one error mapping (`src/llm/provider.ts`); each adapter only supplies its
endpoint, credentials and model-name mapping. Model ids and prices were read
from each provider's **public catalog**, not from memory — NVIDIA retires models
on published EOL dates and answers `410 Gone` afterwards, which is why
`LLM_MODEL_UNAVAILABLE` exists and is retryable.

`NVIDIA_API_KEY` unlocks NVIDIA's free developer tier (~40 rpm, no card).
NVIDIA's own FAQ puts *production* use — anything beyond development, testing,
research or evaluation — under NVIDIA AI Enterprise, so treat it as a
prototyping/failover provider unless you have that entitlement.

OVHcloud AI Endpoints has a genuine anonymous free tier: **2 requests per minute
per IP per model**, no key, no account, no card (verified with a real
completion). It is opt-in via `OVH_AI_ENDPOINTS_ALLOW_ANONYMOUS=true` precisely
because 2 rpm is a development/failover convenience, not a production path. With
an access token the limit is 400 rpm per Public Cloud project per model, and the
project needs a payment method (Discovery-mode projects cannot use the service).

Provider errors map to stable codes, and only the retryable ones advance the
fallback chain:

| Provider HTTP | Code | Our HTTP | Retried with the next model? |
|---|---|---|---|
| 401 / 403 | `LLM_AUTH` | 500 | no — our configuration is wrong |
| 404 / 410 | `LLM_MODEL_UNAVAILABLE` | 502 | yes — the model is gone, others may not be |
| 429 | `LLM_BUSY` | 503 | yes |
| 5xx | `LLM_PROVIDER_ERROR` | 502 | yes |
| timeout | `LLM_TIMEOUT` | 504 | yes |
| bad body | `LLM_MALFORMED` | 502 | no — retrying will not fix a broken contract |

The classifier, filters, tier model and strategy registry are adapted from
**ClawRouter** (BlockRunAI/ClawRouter), MIT © 2026 BlockRunAI — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Only routing logic was taken;
SonPay's x402/XRP/RLUSD payment layer and facilitators are unchanged.

## Usage metering and the platform fee

After a payment verifies **and** a provider actually answers, the server does
three more things, in this order:

1. **Normalize tokens** — the provider's own `usage` block becomes
   `{inputTokens, outputTokens, totalTokens}`. The total is derived from the
   parts only when the provider did not send one; when it did, its total wins
   (some providers count cached/reasoning tokens in it). Nothing is ever
   invented: a count the provider did not report stays `undefined`.
2. **Report usage to OpenMeter** — one `kong.llm_request` CloudEvent per paid
   request.
3. **Price the request** — provider cost, customer price and platform fee, in
   `pricing`.

The split is deliberate: **OpenMeter records usage only. Payment, routing and
pricing stay in Sonpay** — no price, fee, or payment amount is ever sent to the
meter.

### The event

`POST ${OPENMETER_URL}${OPENMETER_EVENTS_PATH}`, with
`Content-Type: application/cloudevents+json` and
`Authorization: Bearer ${OPENMETER_API_KEY}`:

```jsonc
{
  "specversion": "1.0",
  "type": "kong.llm_request",       // the meter's event type
  "id": "sonpay:<payment id>",      // deterministic — this is the dedupe key
  "source": "sonpay",               // OPENMETER_SOURCE
  "subject": "rPayer…",             // the customer
  "time": "2026-09-03T12:00:00.000Z",
  "datacontenttype": "application/json",
  "data": {
    "request_id": "sonpay:<payment id>",
    "customer": "rPayer…",          // payer address, else "payment:<payment id>"
    "model": "Qwen3.5-397B-A17B",
    "provider": "ovhcloud",
    "input_tokens": 12,             // omitted if the provider did not report it
    "output_tokens": 5,             // omitted if the provider did not report it
    "total_tokens": 17,
    "payment_id": "<tx hash or nonce>",
    "payment_asset": "XRP",
    "tokens": 17,                   // the metered value: $.tokens, SUM
    "type": "total"
  }
}
```

The meter it feeds is key `llm_tokens_total` ("LLM Tokens"), event type
`kong.llm_request`, aggregation `SUM` over `$.tokens`.

`OPENMETER_URL` is the **regional Kong Konnect API host** for hosted Metering &
Billing (`https://in.api.konghq.com`, `us`/`eu`/`au` likewise), or your own host
with `OPENMETER_EVENTS_PATH=/api/v1/events` for self-hosted OpenMeter. A
serverless-gateway proxy hostname (`kong-xxxx.kongcloud.dev`) is **not** the
ingest endpoint — it answers `no Route matched with those values` on every path.

Both `OPENMETER_URL` and `OPENMETER_API_KEY` must be set, or metering is simply
`disabled` and the server answers exactly as before. The key is read from the
environment at startup and never appears in a log line, an error, or a response.

### Who gets billed

The `customer` is the **verified payer identity**, and it is always derived
server-side from the facilitator's verification: the sending account of the
on-ledger transaction (`QuickNodeFacilitator`) or the `payer` the hosted
facilitator reports (`T54Facilitator`). Nothing in the request body can
influence it — otherwise any caller could charge its tokens to somebody else's
customer just by asking.

OpenMeter only counts an event against a customer when some Customer entity
claims its `subject`; an unclaimed event is stored and summed by the meter but
comes back with `no customer found for event subject` and never reaches a bill.
So before the first event for a payer, the server upserts the mapping:

```jsonc
POST ${OPENMETER_URL}${OPENMETER_CUSTOMERS_PATH}
{ "name": "rPayer…", "key": "rPayer…",
  "usage_attribution": { "subject_keys": ["rPayer…"] } }
```

The key **is** the subject, which makes the upsert idempotent: a repeat
collides on the key (`409`) instead of creating a second customer. On a `409`
the server reads the customer back and reports whether it really claims that
subject (`exists` vs `exists-unmapped`) — it never overwrites attribution an
operator configured by hand. Set `OPENMETER_AUTO_CREATE_CUSTOMERS=false` to
manage customers yourself; the server then never writes to the customer list.

The upsert runs **before** the event, because a customer created afterwards does
not retroactively claim it. It cannot cost you the usage, though: if it fails,
the event is still reported (`"customer": {"status": "failed", …}` next to a
normal `"status": "sent"`) and the mapping can be repaired for later events.

A payment no facilitator can attribute — the mock facilitator never can — is
metered under `payment:<payment id>` and deliberately gets **no** customer: one
customer per payment would be noise, not billing.

### Rules it holds to

- **A duplicate payment cannot create duplicate usage.** The event id is
  `${OPENMETER_SOURCE}:${payment_id}`, so a replayed `X-PAYMENT` header produces
  the same id; OpenMeter deduplicates on `(source, id)`, and the server also
  keeps a bounded in-process set of ids it has already sent, reporting
  `{"status":"duplicate"}` without a second call. Ids are only remembered when
  OpenMeter actually accepted them, so a failed send stays retryable.
- **A metering failure never re-runs the model.** The ingest call has its own
  deadline (`OPENMETER_TIMEOUT_MS`) and never throws: a rejection, an
  unreachable meter, or a timeout returns `{"status":"failed","reason":…}`
  alongside a normal `200` with the answer the caller paid for.
- **A stub answer is not metered** — a stub burns no tokens — and neither is a
  response that carried no `usage` block (`{"status":"skipped","reason":
  "no-token-usage"}`).
- **A client cannot pick who gets billed.** The customer comes from the
  facilitator's verification, never from the request body.

### Verified against the live meter

One real paid request on 2026-09-04 — XRPL testnet payment
`5A236CCE…4AECF7A` verified by `QuickNodeFacilitator`, answered by
`Meta-Llama-3_3-70B-Instruct`, 43 tokens — against
`https://in.api.konghq.com/v3/openmeter/events`:

- the event was accepted (`202`) and came back from `GET /v3/openmeter/events`
  linked to `customer.id` `01M1NZ8G0DYKXZJTC9VEFYP6KY`, **with no
  `validation_errors`** (an earlier unattributed event on the same instance
  still carries `no customer found for event subject`);
- `POST /v3/openmeter/meters/llm_tokens_total/query` went `262` → `305`, exactly
  `+43`;
- the customer list holds one entry, `key` = `name` =
  `rsHzeudMpRr1rdJqPWqcjNi3Z8khCvMBBQ` = the payer that signed the transaction,
  with `usage_attribution.subject_keys` claiming that same subject;
- re-posting the byte-identical CloudEvent returned `202` and left the meter at
  `305`.

### The fee

```
provider cost = (input_tokens × prompt rate + output_tokens × completion rate) / 1e6
customer price = provider cost × (1 + PLATFORM_MARKUP_BPS / 10000)
platform fee   = customer price − provider cost
```

`PLATFORM_MARKUP_BPS=500` (the default) is 5%. The fee is computed as the
difference, so `providerCostUsd + platformFeeUsd === customerPriceUsd` exactly;
amounts are USD rounded to 10 decimals, because rounding a sub-cent request to
cents would erase the fee entirely.

```jsonc
"pricing": {
  "currency": "USD",
  "providerCostUsd": 0.00002977,
  "markupBps": 500,
  "customerPriceUsd": 0.0000312585,
  "platformFeeUsd": 0.0000014885
}
```

Pricing requires **both** published rates and **both** token counts. Anything
else is reported honestly instead of guessed — the response carries
`pricingUnavailable` (`model-has-no-published-price` or `no-token-usage`) and no
`pricing` object. Such a request is still metered: unknown price does not mean
unknown usage.

## T54 Trustline risk gate (optional, off by default)

Trustline is T54's agent-underwriting API: it answers *should this agent's
transaction be allowed to execute?* Sonpay asks it at the one moment where the
answer is still actionable — **after** the x402 payment is verified and
**before** a single provider token is spent.

It is off unless both variables are set:

```bash
T54_TRUSTLINE_BASE_URL=https://portal.t54.ai/api/v1
T54_TRUSTLINE_API_KEY=tl_sandbox_...        # runtime only, never committed
```

With them unset, `/v1/chat` makes no Trustline call, returns no `risk` field,
and behaves exactly as it did before. x402, the QuickNode and T54 facilitators,
the router, the providers and OpenMeter are untouched either way.

### The API it speaks

Verified live against the sandbox key on 2026-09-06:

| Call | Result |
|---|---|
| `POST /validation/assess-async` | `200` `{schema_version:"underwriting_async_submission.v1", status:"pending", trustline_transaction_id:"tl_txn_…", job_id, poll_url, retry_after_seconds:3}` |
| `GET /underwriting/transactions/{id}` | the same transaction: `status`, and once `completed` a `decision` of `APPROVE` or `DECLINE` with `risk_level`, `confidence`, `reason_brief`, `reasons` |
| `POST /validation/assess` (sync) | `400 developer_api_key_requires_async_endpoint` — a developer key must use the async pair, so only that pair is implemented |

Auth is `Authorization: Bearer tl_{env}_{key_id}.{secret}` on **both** calls.
The docs say the poll needs no key; the live API answers `401 invalid_api_key`
("Developer API key is required") without one. Sandbox and production share the
base URL — the key prefix picks the environment. `https://api-sandbox.t54.ai`
answers `404` for these paths.

Errors come back as `{"detail":{"code":…,"message":…}}`: `invalid_api_key`
(401, wrong key), `api_key_scope_denied` (403, right key, missing underwriting
scope).

### What Sonpay sends

The payment facts and the routed model — never prompt or completion text:

```jsonc
{
  "assessment_type": "transaction",
  "agent_id": "sonpay-gateway",              // T54_TRUSTLINE_AGENT_ID
  "transaction_data": {
    "transaction": {
      "transaction_id": "<x402 payment id>", // the on-ledger tx hash
      "amount": 1,                           // XRP, converted from drops
      "currency": "XRP",
      "chain": "xrpl:1",
      "recipient": "rGateway…"
    },
    "audit_context": {
      "current_task": "Serve one paid inference request on https://…/v1/chat using model deepseek-chat (deepseek), unlocked by x402 payment <id>.",
      "reasoning_process": "The x402 payment of 1 XRP to rGateway… on xrpl:1 was verified before this assessment, paid by rPayer…. Provider tokens have not been spent yet."
    },
    "request_body": {
      "http": { "url": "https://…/v1/chat", "method": "POST" },
      "body": { "model": "deepseek-chat", "provider": "deepseek", "payment_id": "…", "payment_asset": "XRP", "network": "xrpl:1", "payer": "rPayer…" }
    }
  },
  "metadata": { "source": "sonpay", "environment": "sandbox" }
}
```

with `Idempotency-Key: sonpay:<payment id>` — derived from the payment, never
random, so a replayed request cannot open a second assessment.

### What a decision does

`T54_TRUSTLINE_MODE` decides:

- **`observe` (default)** — the decision is logged (`risk_assessed` /
  `risk_declined`) and reported in the response's `risk` object, and the
  request is answered either way.
- **`enforce`** — a `DECLINE` answers `403 RISK_DECLINED` and **no provider is
  called**. Anything else proceeds.

```jsonc
// 200, observe or approved
{ "content": "…", "usage": {…}, "risk": { "status": "approved", "transactionId": "tl_txn_…", "riskLevel": "low", "confidence": 0.94 } }

// 403, enforce + DECLINE — nothing was spent
{ "error": "RISK_DECLINED", "message": "…", "risk": { "status": "declined", … } }
```

### It fails open, deliberately

By the time the gate runs, the caller has **already paid on ledger**. A
Trustline outage, timeout, scope error or quota problem must not turn a settled
payment into no answer, so everything that is not an explicit `DECLINE`
resolves to `status: "unavailable"` and the request proceeds. Only a decision
Trustline actually returned can block one. The Agentic Challenge flow
(`requires_information`) is not implemented: it resolves to `unavailable` too.

On mainnet the safety rules in `src/mainnet.ts` add two more:
`T54_TRUSTLINE_MODE=enforce` **requires a `tl_production_…` key** — a sandbox
key must not decide whether a real payment executes — and
`T54_TRUSTLINE_BASE_URL` must be `https://`. A sandbox key that only observes
is allowed, with a startup warning that its decisions are test decisions.

The key is read from the environment at startup, never logged, never returned
in a result, and never published: `/v1/config` has no Trustline field at all,
so the console cannot see it. The listening line reports only
`trustline: "observe:sandbox"` or `"off"`.

## The console (web frontend)

`packages/web` is a Vite + React + TypeScript single-page console for the
gateway. It is a **client of this API and nothing else**: it does not import
server code, it holds no state of its own, and it cannot change payment,
routing, metering or provider behaviour. Every number it shows came from an
endpoint below — when the gateway does not publish something, the page says so
instead of inventing it.

| Page | What it is for |
|---|---|
| `/` | Landing: what the gateway is, the live price per request, which models are callable right now |
| `/dashboard` | Every request the gateway has handled — outcome, model, provider, tokens, provider cost, platform fee, payment status, latency |
| `/models` | The model catalog: provider, capabilities, both per-token rates, context window, availability, free/paid |
| `/payments` | Every x402 payment presented — asset, amount, transaction hash (linked to the ledger explorer), payer, status |
| `/usage` | Input / output / total tokens per request, the request id the meter deduplicates on, and whether the event reached OpenMeter |
| `/quickstart` | The endpoint, the documented 402 handshake, and a playground that runs the real handshake against this gateway |
| `/keys` | Honest by design: this gateway issues no API keys, and the create form prints the real `501` rather than minting one |

### The endpoints it reads

These were added for the console. They are **additive and read-only** — the
x402 middleware, the router, the provider adapters and the OpenMeter reporter
are untouched, and none of these paths can spend money or serve a model.

| Endpoint | Returns |
|---|---|
| `GET /v1/config` | Public configuration: network, asset, price per request, receiver, facilitator name, routing strategy, markup. Never a secret |
| `GET /v1/models` | The model catalog with per-provider availability and why a provider is not callable (`no credentials` vs `no adapter`) |
| `GET /v1/activity?limit=` | The recent-request ledger plus its summary totals |
| `GET /v1/payments?limit=` | The same ledger projected onto its payments |
| `GET /v1/keys` | `{"supported": false}` — and `POST /v1/keys` / `DELETE /v1/keys/:id` answer `501` |

The ledger behind `/v1/activity` and `/v1/payments` is a bounded in-memory ring
(`ACTIVITY_RETENTION`, default 500 requests) written by a middleware that sits
**in front of** the x402 middleware, so a 402 is recorded as the request it is.
It is a rolling window for the dashboard, cleared on restart — OpenMeter holds
the durable usage record.

### Running it

In development the console runs on Vite and proxies `/v1` and `/healthz` to the
gateway, so there is no CORS to configure:

```bash
npm run build                      # router-core, then server, then the console
npm run dev:server                 # gateway on $PORT (default 8080)
VITE_API_TARGET=http://127.0.0.1:8080 npm run dev:web   # console on :3000
```

In production, point `WEB_DIST` at the built assets and the gateway serves the
console itself, from the same origin as the API:

```bash
WEB_DIST=packages/web/dist npm start
```

## Going live on XRPL Mainnet

The gateway runs the same code on testnet and mainnet; only configuration
differs. That makes the configuration the safety boundary, so it is checked at
startup — `assertProductionSafety()` in
[`packages/server/src/mainnet.ts`](packages/server/src/mainnet.ts) runs from
`createFacilitator()`, the single choke point every facilitator is built
through. A mainnet deployment that is missing or contradictory configuration
**does not start**, and it reports every problem at once.

### The production environment set

```bash
SONPAY_ENV=production
XRPL_NETWORK=xrpl:0                       # XRPL Mainnet
PAYMENT_RECEIVER=r...                     # your mainnet receiving address
PAYMENT_ASSET=XRP                         # or RLUSD (+ the MAINNET RLUSD_ISSUER)
PAYMENT_REWARD_DROPS=1000000              # 1 XRP, in drops
PAYMENT_FACILITATOR=quicknode             # or t54 — "mock" is refused
XRPL_RPC_URL=https://<your-mainnet-node>  # quicknode path, https only
T54_FACILITATOR_URL=https://xrpl-facilitator-mainnet.t54.ai   # t54 path only
OPENMETER_URL=https://in.api.konghq.com
OPENMETER_API_KEY=...                     # runtime only, never committed
```

`SONPAY_ENV` may be left unset: it is then **derived** from `XRPL_NETWORK`, so
`xrpl:0` alone turns the production rules on rather than off. A declared value
that contradicts the network is an error in both directions.

### What production refuses

| Refused | Why |
|---|---|
| `PAYMENT_FACILITATOR=mock` (explicit **or** by default) | The mock accepts a signed nonce instead of an on-ledger payment. The legacy "mock + `XRPL_RPC_URL` silently becomes QuickNode" auto-selection does not apply on mainnet: the operator must name the facilitator that gates the money |
| `XRPL_NETWORK` that is not `xrpl:0` | Production settles on mainnet or not at all |
| `XRPL_NETWORK=xrpl:0` with `SONPAY_ENV=development` | Mainnet configuration running with the safety rules off |
| A testnet/devnet/localhost `XRPL_RPC_URL` or `T54_FACILITATOR_URL` | Test funds are free; they must not buy real answers |
| A mainnet RPC endpoint while `XRPL_NETWORK` is testnet | A payment verified on the wrong network is not a payment |
| A plaintext `http://` RPC or facilitator URL | Verification data must not be readable in transit |
| A missing or malformed `PAYMENT_RECEIVER` | Payments would land nowhere |
| `PAYMENT_ASSET=RLUSD` with no issuer, a malformed issuer, or the **testnet** RLUSD issuer | Test RLUSD is worthless |
| An unsupported asset, or a non-positive `PAYMENT_REWARD_DROPS` | The verifier cannot check what it cannot price |

Metering is the deliberate exception: production **warns** at startup when
`OPENMETER_URL`/`OPENMETER_API_KEY` are unset (and when no provider has
credentials, or unconfigured providers may still be routed to) but keeps
running. A metering outage must never take down a payment gateway; the payment
path does not depend on it.

Nothing mainnet is hardcoded anywhere in the code. The only literal address in
`mainnet.ts` is the **testnet** RLUSD issuer, present solely as a denylist.

### What the console shows on mainnet

`GET /v1/config` gains `environment`, `payment.networkLabel`,
`payment.mainnet` and `payment.live`, and the console reads all four from the
server rather than guessing:

- a standing banner: **XRPL Mainnet · payments are real XRP · verified on-ledger by `<facilitator>`**
- the footer status line and the landing page read *XRPL Mainnet* instead of `xrpl:0`
- the quickstart warns, before you sign, that the payment moves real XRP
- the answer panel shows the settled transaction hash, linked to
  [livenet.xrpl.org](https://livenet.xrpl.org)
- the "Simulate payment (mock facilitator)" button is driven by `payment.live`,
  so it cannot appear on mainnet — where the mock cannot run at all

`/v1/config` still publishes nothing secret: no provider key, no OpenMeter URL
or token, no facilitator or RPC URL. A test asserts this.

### First real mainnet transaction

1. Fund and control a mainnet receiving address (reserve: 1 XRP as of today).
   The gateway never holds a key — it only ever reads a transaction hash.
2. Set the environment set above on the gateway host. Keep
   `PAYMENT_REWARD_DROPS` small for the first run (e.g. `100000` = 0.1 XRP).
3. Start the gateway and read the `server_listening` line: it must show
   `environment: production`, `network: xrpl:0`, `networkLabel: XRPL Mainnet`
   and the facilitator you configured. If it did not start, the error lists
   every configuration problem.
4. `curl -isS -X POST https://<host>/v1/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}'`
   → `402` with `WWW-Authenticate: x402` and a challenge whose `network` is
   `xrpl:0`, `receiver` is your address, and `nonce` is single-use.
5. From **your own wallet** (Xaman, Crossmark, GemWallet, the `xrpl` library),
   send exactly `rewardDrops` to `receiver` with the challenge nonce
   hex-encoded into the transaction's `MemoData`. Sonpay never asks for a seed
   and never signs for a payer.
6. Wait for the transaction to be validated, then retry the identical request
   with `X-PAYMENT: {"txHash":"<hash>","payment":<the challenge's payment object>}`.
7. Expect `200` with the answer, the routed model and the price breakdown. The
   payment appears on `/payments` with its hash linked to livenet, and the
   usage event reaches OpenMeter.
8. Replay the same `X-PAYMENT` header once: it must come back `402`
   (`payment-already-used`). One payment, one request.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the server listens |
| `SONPAY_ENV` | *(derived from `XRPL_NETWORK`)* | `development` or `production`. `production` turns on the XRPL Mainnet safety rules (see above) and refuses a mock facilitator, a testnet network/URL, a missing receiver or an inconsistent asset. An unrecognised value is an error, never a silent fallback |
| `XRPL_NETWORK` | `xrpl:1` | `xrpl:1` = testnet, `xrpl:0` = mainnet. On its own, `xrpl:0` puts the server in production mode |
| `PAYMENT_RECEIVER` | *(empty)* | Address that collects payments (required for real verification) |
| `PAYMENT_REWARD_DROPS` | `1000000` | Per-request amount: XRP drops when `PAYMENT_ASSET=XRP`, value (e.g. `0.01`) when `PAYMENT_ASSET=RLUSD` |
| `PAYMENT_FACILITATOR` | `mock` | Which payment facilitator: `mock` (default — current zero-config behavior: in-process real verifier when `XRPL_RPC_URL` is set, else in-memory mock), `quicknode` (real on-ledger verification via `XRPL_RPC_URL`), or `t54` (hosted T54 facilitator via `T54_FACILITATOR_URL`) |
| `T54_FACILITATOR_URL` | *(empty)* | Hosted T54 x402 facilitator base URL — required only when `PAYMENT_FACILITATOR=t54` (testnet `https://xrpl-facilitator-testnet.t54.ai`, mainnet `https://xrpl-facilitator-mainnet.t54.ai`) |
| `XRPL_RPC_URL` | *(empty)* | XRPL JSON-RPC endpoint for REAL on-ledger verification (e.g. QuickNode, or testnet `https://s.altnet.rippletest.net:51234`). Used when `PAYMENT_FACILITATOR=quicknode`. Empty + `mock` = zero-config local dev |
| `PAYMENT_ASSET` | `XRP` | `XRP` or `RLUSD` (canonical 40-hex currency code `524C555344...`) |
| `RLUSD_ISSUER` | *(empty)* | RLUSD issuer — required only when `PAYMENT_ASSET=RLUSD` |
| `LLM_API_KEY` | *(empty)* | DeepSeek API key. Empty = stub replies (`stub: true`) |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint base |
| `LLM_TIMEOUT_MS` | `30000` | Deadline for one LLM call (all providers) |
| `NVIDIA_API_KEY` | *(empty)* | NVIDIA NIM key (`nvapi-…`). Empty = the `nvidia` provider is not callable |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Hosted NIM base URL |
| `OVH_AI_ENDPOINTS_ACCESS_TOKEN` | *(empty)* | OVHcloud AI Endpoints token (400 rpm). Optional — see the anonymous tier below |
| `OVH_AI_ENDPOINTS_BASE_URL` | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | AI Endpoints base URL |
| `OVH_AI_ENDPOINTS_ALLOW_ANONYMOUS` | `false` | Allow calling OVHcloud with no token: free, but 2 requests/min/IP/model |
| `ROUTING_STRATEGY` | `cheapest` | `cheapest` (original behavior) or `tiered` (classify the prompt, then pick the cheapest model that meets the tier) |
| `ROUTING_SKIP_UNCONFIGURED_PROVIDERS` | `false` | Route only to providers this server can actually call (adapter + API key) |
| `ROUTING_MAX_ATTEMPTS` | `2` | Models from the fallback chain one request may try after a retryable provider failure |
| `OPENMETER_URL` | *(empty)* | Usage-metering base URL: the regional Konnect API host (`https://in.api.konghq.com`) for hosted Metering & Billing, or your own OpenMeter host. Empty = metering disabled |
| `OPENMETER_API_KEY` | *(empty)* | Konnect token (`kpat_…` / `spat_…`) or OpenMeter API key. **Runtime only — never commit it.** Empty = metering disabled |
| `OPENMETER_EVENTS_PATH` | `/v3/openmeter/events` | Ingest path appended to `OPENMETER_URL` (self-hosted OpenMeter uses `/api/v1/events`) |
| `OPENMETER_CUSTOMERS_PATH` | `/v3/openmeter/customers` | Customer path appended to `OPENMETER_URL` (self-hosted OpenMeter uses `/api/v1/customers`) |
| `OPENMETER_AUTO_CREATE_CUSTOMERS` | `true` | Register a verified payer as an OpenMeter customer before reporting its usage. `false` = you manage customers in the Konnect UI and the server never writes to the customer list |
| `OPENMETER_SOURCE` | `sonpay` | CloudEvents `source`; also namespaces the event id, which is what deduplicates a replayed payment |
| `OPENMETER_TIMEOUT_MS` | `5000` | Deadline for one ingest call — a slow meter never holds up a paid answer |
| `T54_TRUSTLINE_BASE_URL` | *(empty)* | T54 Trustline API base (`https://portal.t54.ai/api/v1`). Empty = the optional risk gate is off |
| `T54_TRUSTLINE_API_KEY` | *(empty)* | Trustline developer key, `tl_{env}_{key_id}.{secret}`. **Runtime only — never commit it.** Empty = the gate is off |
| `T54_TRUSTLINE_MODE` | `observe` | `observe` (decide and log, answer either way) or `enforce` (a `DECLINE` answers `403 RISK_DECLINED` and no provider is called). Any other value is a startup error |
| `T54_TRUSTLINE_AGENT_ID` | `sonpay-gateway` | `agent_id` the assessment is filed under at T54 |
| `T54_TRUSTLINE_TIMEOUT_MS` | `15000` | Deadline for one assessment (submit + polling). On timeout the request proceeds — it is already paid for |
| `PLATFORM_MARKUP_BPS` | `500` | Markup on the provider's cost in basis points (`500` = 5%). `0` is legal: cost with no fee |
| `ACTIVITY_RETENTION` | `500` | Requests the console's in-memory ledger keeps (`/v1/activity`, `/v1/payments`). A rolling window, not a billing record |
| `WEB_DIST` | *(empty)* | Directory of built console assets for the gateway to serve (e.g. `packages/web/dist`). Empty = API only, which is what you want when Vite serves the console in dev |
| `VITE_API_TARGET` | `http://127.0.0.1:8080` | Dev only, read by `packages/web/vite.config.ts`: where the Vite dev server proxies `/v1` and `/healthz` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

(`XRPL_FACILITATOR_URL` from earlier docs is deprecated: the current design
verifies in-process via `XRPL_RPC_URL`, or via the hosted T54 facilitator when
`PAYMENT_FACILITATOR=t54` is set.)

Never commit your `.env` or any private key — the repo's `.gitignore` already
excludes it.

## Development

```bash
npm test          # build + run all Jest suites across workspaces
npm run build     # router-core, then server, then the console (order matters)
npm run dev:server  # gateway from packages/server/dist
npm run dev:web     # console on :3000, proxying to $VITE_API_TARGET
```

Tests use injected fakes (mock facilitator, injectable fetch) — nothing touches
the network.

## Roadmap

1. [x] x402 challenge/verify flow (mock facilitator)
2. [x] Deterministic cheapest-capable routing (+ ClawRouter-derived tiered strategy, fallback chains, provider availability)
3. [x] Real LLM providers: DeepSeek, NVIDIA NIM, OVHcloud AI Endpoints (shared OpenAI-compatible adapter + cross-provider fallback)
4. [x] Real on-ledger XRP payment verification via XRPL JSON-RPC (no xrpl.js, no hosted facilitator)
5. [x] T54 hosted facilitator as an OPTIONAL second facilitator (PAYMENT_FACILITATOR=t54, verify+settle via T54_FACILITATOR_URL)
6. [~] RLUSD support (same verification path, unit-tested + env-driven flow; live testnet smoke test pending — needs operator testnet RLUSD funds, see "Smoke-test on testnet — RLUSD")
7. [x] Usage ledger — per-request token usage reported to OpenMeter as `kong.llm_request` (idempotent per payment; failures never re-run the model)
8. [x] Platform fee/markup on each request (`PLATFORM_MARKUP_BPS`, default 5%; unpriced models are metered, never guessed)
9. [x] Web console — landing, dashboard, models, payments, usage, quickstart playground and keys, on additive read-only endpoints (`packages/web`)
10. [x] XRPL Mainnet production support — env-driven mainnet configuration, fail-fast safety rules (`SONPAY_ENV`, no mock/testnet in production), and a console that says which network it is on (see "Going live on XRPL Mainnet")

## License

Not yet chosen — a LICENSE file will be added before first public release.
Third-party code included in this repository (currently the MIT-licensed
ClawRouter routing logic) is credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which reproduces its license.
