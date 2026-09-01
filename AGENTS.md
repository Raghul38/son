# AGENTS.md — XRP-Pay Router

Guidance for AI agents working in this repository.

## Durability rules (owner-directed 2026-09-01)
- Everything outside `/home` is wiped when the computer restarts. This GitHub repo is the durable record of the work.
- **Push a feature branch and open a PR as soon as a unit of work is complete** — never leave finished work only on local disk.
- Work in `/tmp` (large but wiped on restart; re-clone from GitHub as needed).
- Do NOT install `node_modules` or package caches under `/home` (only 300M). Set the npm cache to `/tmp/npm-cache`.

## Repo conventions
- npm workspaces monorepo: `packages/router-core` (pure, deterministic router logic) and `packages/server` (Express + x402 middleware).
- `router-core` must stay free of network/payment code — pure and unit-testable in isolation.
- The server never signs for a payer — it only verifies/settles via a facilitator.
- No hardcoded private keys or mainnet addresses anywhere; all URLs/addresses/network ids come from env vars.

## Commands
- `npm install` (set `npm_config_cache=/tmp/npm-cache` first).
- `npm test` — runs Jest across all workspaces.
- `npm run build` — builds router-core then server (order matters: server depends on router-core's compiled output).
