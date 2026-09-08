/**
 * Vercel serverless entrypoint for the Sonopay gateway.
 *
 * ADAPTER ONLY — no business logic lives here. It serves the existing Express
 * app assembled by `createServer()` in `packages/server` (the same
 * `createApp()` assembly that serves POST /v1/chat locally) WITHOUT calling
 * `listen()`: Vercel invokes the exported handler, which forwards to the app,
 * instead. The payment flow, provider flow, and all gateway logic are
 * unchanged inside the package.
 *
 * `vercel.json` rewrites every path to this function with the original URL
 * preserved, so Express routing (GET /healthz, POST /v1/chat) works as-is.
 * `packages/server/src/index.ts` stays untouched as the local/long-running
 * entrypoint.
 *
 * The app is built lazily on first invocation and reused while the instance
 * is warm. If the configuration is invalid, loadConfig() fails fast at
 * startup here — expressed as a 500 with the reason, since there is no
 * long-running process to crash at startup.
 *
 * The import below targets the compiled output (`npm run build`, also Vercel's
 * buildCommand) so this file never duplicates the server's own compilation.
 * Loose types are deliberate: this file must compile under Vercel's isolated
 * function typecheck exactly as it does here.
 */
import { createServer } from '../packages/server/dist/index.js';

type ExpressApp = (req: any, res: any) => void;

let cached: ExpressApp | undefined;
let initError: unknown;

function getApp(): ExpressApp {
  if (cached === undefined) {
    try {
      cached = createServer().app as unknown as ExpressApp;
    } catch (err) {
      initError = err;
    }
  }
  if (cached === undefined) {
    throw initError;
  }
  return cached;
}

export default function handler(req: any, res: any): void {
  let app: ExpressApp;
  try {
    app = getApp();
  } catch {
    res.status(500).json({
      error: 'SERVER_MISCONFIGURED',
      message: initError instanceof Error ? initError.message : String(initError),
    });
    return;
  }
  app(req, res);
}
