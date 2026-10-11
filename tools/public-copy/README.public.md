# Sela

Shared savings goals on Solana. Families and friends set a goal together,
contribute USDC, and approve spending with a device passkey instead of a
seed phrase.

Made by TJS Code. Built for the Crypto World's Fair hackathon.

## What is in here

| Part | What it does | Where |
| --- | --- | --- |
| Web app | Plain HTML, CSS and JS dashboard, no framework | `index.html`, `dashboard.html`, `style.css`, `app.js` |
| Payments | USDC transfers on Solana mainnet, sent through Jito with an RPC dual send and a retry agent | `veil-engine.js`, `smart-tx.js`, `netlify/functions/submit-bundle.js` |
| Goals and vaults | Anchor program with shared goals, recurring allowances and passkey approvals, deployed on devnet | `programs/`, `program-client.js`, `goals-tab.js` |
| Goal token | A Meteora Dynamic Bonding Curve token per goal, devnet | `goal-token-dbc/`, `netlify/functions/goal-token-*.js` |
| RPC Fast | Every mainnet RPC call goes through one server side proxy that points at RPC Fast, plus a live health check | `lib/rpcClient.js`, `netlify/functions/rpc-proxy.js`, `netlify/functions/rpc-health.js` |
| Solami | Activity feed fed by Solami's Blur data stream, with a script that checks your key | `lib/activitySource.js`, `netlify/functions/activity-feed.js`, `solami-verify.mjs` |

Networks: payments, RPC Fast and Solami run on mainnet. The Anchor program
and the goal token run on devnet. `sela-config.js` holds the one setting
(`PROGRAM_CLUSTER`) that moves the program side to mainnet later.

## Run it yourself

You need Node 20 or newer and the Netlify CLI.

```bash
git clone <this repo>
cd <this repo>
npm install
npm install -g netlify-cli
cp .env.example .env        # then fill in what you need, see below
netlify dev                 # serves the site and the functions on http://localhost:8888
```

Open `http://localhost:8888/dashboard.html`. The interface loads with no
keys at all. What each key unlocks:

| Variable | Needed for |
| --- | --- |
| `RPC_HTTP_URL` | Everything on mainnet: payments, balances, the RPC health pill. Use your RPC Fast HTTPS endpoint, or any Solana RPC URL. |
| `RPC_REGION_LABEL` | Optional text for the health pill, for example `Frankfurt`. |
| `DEVNET_RPC_URL` | Optional. Defaults to the public devnet endpoint, which is enough for goals. |
| `ACTIVITY_SOURCE` | `mock` (default, clearly labelled in the UI) or `solami` for live data. |
| `SOLAMI_API_KEY` | Live activity feed from Solami. Used only on the server. |
| `SOLAMI_ACTIVITY_TYPES`, `SOLAMI_ACTIVITY_ADDRESS`, `SOLAMI_POLL_WINDOW_MS` | Optional feed filters and listening window. |
| `GROQ_API_KEY` | The AI retry agent for payments. |
| `HELIUS_API_KEY` | Legacy fallback if `RPC_HTTP_URL` is not set. |
| `KEEPER_KEYPAIR_JSON` | The keeper that submits recurring allowances. |

Keys live in Netlify environment variables or a local `.env`. Nothing in
this repository contains a key, and none should ever be added.

## Check your Solami key

```bash
mkdir solami-check && cd solami-check
cp ../solami-verify.mjs .
npm init -y && npm install solami ws
read -rs -p "Solami key: " SOLAMI_API_KEY && export SOLAMI_API_KEY
node solami-verify.mjs
```

It makes one RPC call with the official SDK, then listens to the Blur
stream for 20 seconds, counts the event types it sees and saves samples
to `blur-samples.json`. The key is read from the environment and never
printed.

## RPC Fast

All mainnet RPC calls go to `/api/rpc`, a Netlify Function that holds the
endpoint server side. `/.netlify/functions/rpc-health` runs real `getSlot`
calls through the same code path and returns the provider name, slot and
measured latency, never the URL or key. The dashboard shows it as a pill.

## Meteora Dynamic Bonding Curve

The goal token launches on a Meteora DBC pool on devnet. The pool reached
its 12 USDC migration threshold and migrated to DAMM v2:

- Base mint: `AEKzjGPaBoQWfqFAoa6hDZJHBptSC2nab5yw5R2PLvF8`
- Final swap: `34JRddA6uV82GhASaMGDywi7PTQgLNRZg3v4LWus9e1jbpW787UoUNAM51SCvdqriGA97A4TSQyuKxiA4fZMN2BH`
- Migration: `2H4HQyFVdKP7c7GERSwshCEmHwPoY2ouvQFMqVkU6yqsXmVapvPB5NH6PVwJtvUjeW2zoxJo79yraLEXKpGe3beb`

Open either hash on Solana Explorer with the devnet cluster selected.
`goal-token-dbc/studio-config/finish-curve.mjs` explains why the last gap
needed a partial fill swap and how it was closed.

## Not finished

- Mobile wallet browsers: passkeys do not work inside wallet in-app
  browsers yet. Use a desktop browser with a wallet extension.
- The naira ramp is built but switched off until the payment partner
  finishes verification.
- The Anchor program is on devnet only.
