# Third-party notices

This project includes code adapted from third-party open-source projects.
The notices below are reproduced as required by their licenses.

## ClawRouter (BlockRunAI/ClawRouter)

- Upstream: <https://github.com/BlockRunAI/ClawRouter>
- npm package: `@blockrun/clawrouter` v0.12.267
- Commit inspected: `6bc5a30764cf`
- Source of the adapted routing logic: `dist/router/index.js` (the committed,
  MIT-licensed bundle of `@blockrun/router-core`, which is not published to npm
  separately)
- License: MIT

**What was adapted.** Only the *routing* logic was used: the rule-based prompt
classifier (weighted dimension scoring + sigmoid confidence calibration), the
tier model (SIMPLE / MEDIUM / COMPLEX / REASONING) with primary+fallback
chains, the candidate filters (tool/vision capability, exclude list, context
capacity, unavailable models), and the pluggable strategy registry. The code
was re-implemented against this repository's own types (`ModelSpec`,
`Capability`, `NoRouteError`) rather than copied verbatim; the files that
carry adapted logic name it in a header comment.

**What was NOT taken.** No BlockRun payment, facilitator, proxy, provider-
gateway, or prediction-market code was copied. SonPay's x402 / XRP / RLUSD
payment layer (`packages/server/src/x402.ts`,
`packages/server/src/facilitator/*`) is entirely its own and unchanged.

```
MIT License

Copyright (c) 2026 BlockRunAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
