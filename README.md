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
   const memoHex = Buffer.from('<payment.nonce from the challenge>', 'utf8').toString('hex');
   const amount = {
     currency: '524C555344000000000000000000000000000000', // RLUSD
     value: '<payment.rewardDrops>',                        // e.g. "0.01"
     issuer: '<RLUSD_ISSUER>',                              // the configured issuer
   };
   await client.submitAndWait(wallet.sign({
     TransactionType: 'Payment',
     Account: wallet.classicAddress,
     Destination: '<payment.receiver>',
     Amount: amount,
     Memos: [{ Memo: { MemoType: 'x402', MemoData: memoHex } }],
     NetworkID: 1,                              // testnet; 0 for mainnet
     Fee: '12',
   }));
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

## Payment verification checklist (in-process, fail-closed)

For every submitted `X-PAYMENT` the server fetches the transaction from the
XRPL JSON-RPC node (`XRPL_RPC_URL`) and requires ALL of:

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
2. [x] Deterministic cheapest-capable routing
3. [x] DeepSeek as first real LLM provider
4. [x] Real on-ledger XRP payment verification via XRPL JSON-RPC (no xrpl.js, no hosted facilitator)
5. [~] RLUSD support (same verification path, unit-tested + env-driven flow; live testnet smoke test pending — needs operator testnet RLUSD funds, see "Smoke-test on testnet — RLUSD")
6. [ ] Usage/cost ledger (append-only JSONL per request)
7. [ ] Platform fee/markup on each request

## License

Not yet chosen — a LICENSE file will be added before first public release.
