# @xrppay/sdk-ts

TypeScript client SDK for the XRP-Pay Router. `RouterClient.chat()` implements
the full **x402 pay-and-retry flow**: send a chat request, get a 402 payment
challenge, sign the requested XRP payment with **your own wallet** (the SDK
never sees, generates, or stores private keys), retry with the signed payment,
and return the final routed LLM response.

Works against the `@xrppay/server` gateway running locally with the mock
facilitator (zero config, no real funds), and is designed for the real XRPL
facilitator wire-up that comes next.

## Install

```bash
npm install @xrppay/sdk-ts
```

(Within this monorepo it is the `@xrppay/sdk-ts` workspace under
`packages/sdk-ts`.)

## Quickstart — local server + mock facilitator

Start the router server locally (from the repo root) with the zero-config
mock facilitator — no real funds, no XRPL node needed:

```bash
export npm_config_cache=/tmp/npm-cache  # if your /home is small
npm install
npm run build
# Server listens on PORT (default 8080). PAYMENT_RECEIVER must be set
# (any address works with the mock — without it, challenges carry an empty
# receiver and the SDK refuses to sign toward a blank address):
#   PAYMENT_RECEIVER=rMOCKRECEIVERaddress00000000000000000
PAYMENT_RECEIVER=rMOCKRECEIVERaddress00000000000000000 node packages/server/dist/index.js
```

Then use the SDK:

```ts
import { RouterClient, XrplWalletSigner } from '@xrppay/sdk-ts';
import xrpl from 'xrpl'; // your own dependency; the SDK does not pull it in

// 1. Your wallet owns the keys. NEVER put a seed in this code or in the SDK.
const wallet = xrpl.Wallet.fromSeed(process.env.XRPL_TESTNET_SEED!);

const client = new RouterClient({
  routerUrl: process.env.XRPPAY_ROUTER_URL ?? 'http://localhost:8080',
  signer: new XrplWalletSigner(wallet),
});

// 2. One call; the SDK handles 402 -> sign -> retry -> 200.
const reply = await client.chat({
  messages: [{ role: 'user', content: 'What is the cheapest model here?' }],
  capabilities: ['chat'],
  // maxCostPer1MTokens: 0.5,
});

console.log(reply.model, reply.content);
```

The mock facilitator accepts any non-empty signature, so for local dev you can
also pass a trivial signer and skip xrpl.js entirely:

```ts
const client = new RouterClient({
  routerUrl: 'http://localhost:8080',
  signer: {
    address: 'rYOURPUBLICADDRESS...',
    signPaymentRequest: async () => 'local-dev-signature', // mock accepts any string
  },
});
```

### How the flow works

```
   RouterClient (you)                 Gateway server (POST /v1/chat)
          |                                    |
          |   POST {messages, capabilities...} |
          |----------------------------------->|
          |                                    |  (no payment yet)
          |   402 + x402 challenge             |
          |   { scheme, token,                 |
          |     payment: { network, receiver,  |
          |               rewardDrops, nonce,  |
          |               expiresAt, asset? } }|
          |<-----------------------------------|
          |                                    |
          |  signer.signPaymentRequest(payment)|
          |  (your wallet — key never leaves   |
          |   your process)                    |
          |                                    |
          |   POST same body with              |
          |   X-PAYMENT: { nonce, signature,   |
          |                payment: <echoed> } |
          |----------------------------------->|
          |                                    |  verify terms + payment
          |   200 { model, content,            |
          |        costPer1MTokens, usage? }   |
          |<-----------------------------------|
```

Notes on the wire format:

- The `X-PAYMENT` header value is **literal JSON** — `packages/server/src/x402.ts`
  calls `JSON.parse()` on the raw header (this server does not base64-encode;
  if the real t54 facilitator later requires base64url, server and SDK change
  together).
- The `payment` object from the challenge is echoed **verbatim** — the server
  checks its terms (network / receiver / amount / asset) against the ones it
  issued, so never rewrite it.
- Top-level `nonce` + `signature` satisfy the mock facilitator; the future
  on-ledger verification scheme needs a real `txHash`, which you can attach per
  call via `chat(request, { paymentExtras: { txHash } })`.

## Signing

The SDK never contains, generates, or hardcodes private keys. It only defines
the seam:

```ts
interface XrplSigner {
  address?: string;
  signPaymentRequest(paymentRequest: PaymentRequest): Promise<string> | string;
}
```

`XrplWalletSigner` adapts an existing xrpl.js `Wallet` (duck-typed — the SDK
has **no xrpl dependency**; add `xrpl` to *your* project if you use it). Any
signer works: hardware wallet, HSM, hosted signing service — as long as the
signature string is what the target facilitator verifies.

## Errors

All errors extend `RouterClientError` and carry a stable `code`:

| Error                      | `code`               | When                                             |
| -------------------------- | -------------------- | ------------------------------------------------ |
| `HttpError`                | `HTTP_ERROR`         | Non-402 HTTP failure (first attempt or retry)    |
| `PaymentRejectedError`     | `PAYMENT_REJECTED`   | Signed retry got a **second 402** (fresh challenge attached) |
| `MalformedChallengeError`  | `MALFORMED_CHALLENGE`| 402 body was not a valid x402 challenge          |
| `PaymentSigningError`      | `PAYMENT_SIGNING`    | Your signer threw — nothing was retried          |
| `RequestFailedError`       | `REQUEST_FAILED`     | Network failure / timeout / non-JSON 200 body    |

## Configuration

Every URL comes from constructor options; nothing mainnet-specific is
hardcoded:

- `routerUrl` — base URL of the router server (env fallback:
  `XRPPAY_ROUTER_URL`). Required.
- `signer` — your `XrplSigner`. Required (the SDK never signs for you).
- `path` — chat endpoint (default `/v1/chat`).
- `fetch` — injectable fetch for tests / custom runtimes.
- `timeoutMs` — per-request deadline.
- `headers` — extra headers merged into every request.

## Testing

Unit tests use a mocked fetch (no live server):

```bash
npm run test -w @xrppay/sdk-ts
```

They cover the full 402 → sign → retry → 200 cycle, malformed challenges,
signer rejection, non-402 HTTP errors, a second 402 after retry, and network
failures.

## Note on BlockRun

This project intentionally does **not** use BlockRun's own XRPL SDK, which was
sunset on 2026-08-29 (see the repo's `README.md`). The SDK talks to the
gateway's `POST /v1/chat` endpoint only; XRPL interaction happens on the server
side via the facilitator seam, and on the payer side via your own wallet.