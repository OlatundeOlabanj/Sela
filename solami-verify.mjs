// solami-verify.mjs
//
// Checks the two things the Sela activity feed needs from Solami, then
// saves real Blur messages so the field mapping can be written against
// real data instead of guesses.
//
//   1. RPC: official SDK, one getSlot call.
//   2. Blur: connects to the data stream, listens for a short window,
//      counts messages per event type, notes any dex or pool style
//      fields, and saves samples to blur-samples.json.
//      If Blur refuses the connection, this prints the server's own
//      explanation (status, body, headers) and tries the other places a
//      key could go, so one run shows what is actually required.
//
// Setup (in a fresh folder):
//   npm init -y
//   npm install solami ws
//   read -rs -p "Solami key: " SOLAMI_API_KEY && export SOLAMI_API_KEY
//   node solami-verify.mjs
//
// Optional: BLUR_SECONDS=30 to listen longer (default 20).
// Optional: SOLAMI_RPC_KEY, if the key you use for Blur has no RPC access.
// Blur needs a key with the DataApi permission (the server says: missing
// required permission DataApi).
//
// The key is read from the environment and is never printed. Do not
// paste it into chat or commit it.
//
// Made by TJS Code

import { writeFileSync } from 'node:fs';
import { builder } from 'solami';
import WebSocket from 'ws';

const KEY = process.env.SOLAMI_API_KEY;
const RPC_KEY = process.env.SOLAMI_RPC_KEY || KEY; // only needed if your Blur key has no RPC access
const SECONDS = Number(process.env.BLUR_SECONDS) || 20;
const BLUR_BASE = process.env.BLUR_BASE || 'wss://ws.solami.dev';

if (!KEY) {
  console.error('Set SOLAMI_API_KEY first, see the setup notes at the top of this file.');
  process.exit(1);
}

const scrub = (s) => String(s).split(KEY).join('<key>').split(RPC_KEY).join('<key>').replace(/api[_-]?key=[^&\s"']+/gi, 'api_key=<redacted>');

function report(label, ok, detail) {
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (detail) console.log('  ' + scrub(detail).split('\n').join('\n  '));
}

async function checkRpc() {
  try {
    const client = await builder().withRpc(RPC_KEY).build();
    const slot = await client.rpc().connection.getSlot();
    report('RPC getSlot', typeof slot === 'number' && slot > 0, `slot = ${slot}`);
  } catch (err) {
    report('RPC getSlot', false, `${err.name || 'Error'}: ${err.message}`);
  }
}

function typeOf(msg) {
  return String(msg.type ?? msg.event ?? msg.kind ?? msg.event_type ?? 'unknown');
}

// Opens one connection and resolves with how it ended. Used for the
// variations after a rejection. Handshake rejections are not billed.
function probe(url, headers) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { ws.terminate(); } catch (_) { /* closed */ } resolve(r); } };
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => done('no answer in 8s'), 8000);
    ws.on('open', () => { clearTimeout(timer); done('OPENED'); });
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 300) body += c; });
      res.on('end', () => { clearTimeout(timer); done(`HTTP ${res.statusCode} ${body.trim().replace(/\s+/g, ' ')}`); });
    });
    ws.on('error', (e) => { clearTimeout(timer); done('error: ' + e.message); });
  });
}

async function variations() {
  const k = encodeURIComponent(KEY);
  const base = `${BLUR_BASE}/data/subscribe`;
  const tests = [
    ['key in query as api_key, no chain param', `${base}?api_key=${k}`, {}],
    ['key in query as api-key', `${base}?chain=solana&api-key=${k}`, {}],
    ['key in Authorization: Bearer header', `${base}?chain=solana`, { Authorization: `Bearer ${KEY}` }],
    ['key in x-api-key header', `${base}?chain=solana`, { 'x-api-key': KEY }],
    ['key in query plus Origin https://solami.dev', `${base}?chain=solana&api_key=${k}`, { Origin: 'https://solami.dev' }],
  ];
  console.log('\n  Other ways of presenting the key:');
  for (const [label, url, headers] of tests) {
    console.log(`    ${label}: ${scrub(await probe(url, headers))}`);
  }
}

function checkBlur() {
  return new Promise((resolve) => {
    // backfill=3 replays the last 3 events of each type on connect, so samples
    // of every type arrive within a second instead of waiting for live traffic.
    const url = `${BLUR_BASE}/data/subscribe?chain=solana&api_key=${encodeURIComponent(KEY)}&backfill=3&metadata=false`;
    const counts = {};
    const samples = {};
    const dexish = {};
    const meteora = [];
    let total = 0;
    let opened = false;
    let done = false;

    const ws = new WebSocket(url);

    async function finish(note, rejected) {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) { /* already closed */ }

      if (!opened) {
        report('Blur stream', false, note);
        if (rejected) await variations();
      } else {
        report('Blur stream', total > 0, `${total} messages in ${SECONDS}s${note ? '\n' + note : ''}`);
        console.log('  event types seen:', Object.keys(counts).length ? JSON.stringify(counts) : '(none)');
        const dexKeys = Object.keys(dexish);
        if (dexKeys.length) {
          console.log('  dex or pool style fields and values seen:');
          for (const k of dexKeys) console.log(`    ${k}: ${[...dexish[k]].slice(0, 15).join(', ')}`);
        } else {
          console.log('  no dex or pool style fields seen in this window');
        }
        console.log('  messages mentioning meteora, dbc or damm:', meteora.length);
      }
      writeFileSync('blur-samples.json', JSON.stringify({ counts, samples, meteoraMentions: meteora }, null, 2));
      console.log('\n  saved blur-samples.json (paste its contents back, it holds only public chain data)');
      resolve();
    }

    ws.on('open', () => {
      opened = true;
      setTimeout(() => finish(''), SECONDS * 1000);
    });

    ws.on('message', (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch (_) { return; }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const msg of list) {
        if (!msg || typeof msg !== 'object') continue;
        total += 1;
        const t = typeOf(msg);
        counts[t] = (counts[t] || 0) + 1;
        if (!samples[t]) samples[t] = [];
        if (samples[t].length < 2) samples[t].push(msg);
        for (const [k, v] of Object.entries(msg)) {
          if (/dex|launchpad|pool|protocol|program|venue/i.test(k) && typeof v === 'string') {
            if (!dexish[k]) dexish[k] = new Set();
            dexish[k].add(v);
          }
        }
        if (meteora.length < 3 && /meteora|dbc|damm/i.test(JSON.stringify(msg))) meteora.push(msg);
      }
    });

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 800) body += c; });
      res.on('end', () => {
        const headers = Object.entries(res.headers)
          .filter(([k]) => !/set-cookie|authorization/i.test(k))
          .map(([k, v]) => `    ${k}: ${v}`).join('\n');
        finish(
          `Handshake rejected: HTTP ${res.statusCode} ${res.statusMessage || ''}\n` +
          `  Server said: ${body.trim() || '(empty body)'}\n  Response headers:\n${headers}`,
          true,
        );
      });
    });

    ws.on('error', (err) => { finish('Connection error: ' + err.message, false); });

    ws.on('close', (code) => {
      if (!done) {
        finish(code === 4002
          ? 'Closed with code 4002: streaming balance exhausted, check Bandwidth in the Solami dashboard.'
          : `Closed by the server with code ${code}.`, false);
      }
    });
  });
}

console.log('Solami verification for Sela');
await checkRpc();
await checkBlur();
console.log('\nDone.');
process.exit(0);
