// solami-verify.mjs
//
// One run that checks the two things the Sela activity feed needs,
// then saves real Blur messages so the field mapping can be written
// against real data instead of guesses.
//
//   1. RPC: official SDK, one getSlot call.
//   2. Blur: connects to the data stream, listens for a short window,
//      counts messages per event type, notes any dex or pool style
//      fields, and saves samples to blur-samples.json.
//
// Setup (in a fresh folder):
//   npm init -y
//   npm install solami ws
//   export SOLAMI_API_KEY="your Sela Dev key"      (Windows PowerShell: $env:SOLAMI_API_KEY="...")
//   node solami-verify.mjs
//
// Optional: BLUR_SECONDS=30 to listen longer (default 20).
//
// The key is read from the environment and is never printed. Do not
// paste it into chat or commit it.
//
// Made by TJS Code

import { writeFileSync } from 'node:fs';
import { builder } from 'solami';
import WebSocket from 'ws';

const KEY = process.env.SOLAMI_API_KEY;
const SECONDS = Number(process.env.BLUR_SECONDS) || 20;

if (!KEY) {
  console.error('Set SOLAMI_API_KEY first, see the setup notes at the top of this file.');
  process.exit(1);
}

function report(label, ok, detail) {
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (detail) console.log('  ' + String(detail).split('\n').join('\n  '));
}

async function checkRpc() {
  try {
    const client = await builder().withRpc(KEY).build();
    const slot = await client.rpc().connection.getSlot();
    report('RPC getSlot', typeof slot === 'number' && slot > 0, `slot = ${slot}`);
  } catch (err) {
    report('RPC getSlot', false, `${err.name || 'Error'}: ${err.message}`);
  }
}

function typeOf(msg) {
  return String(msg.type ?? msg.event ?? msg.kind ?? msg.event_type ?? 'unknown');
}

function checkBlur() {
  return new Promise((resolve) => {
    const url = `wss://ws.solami.dev/data/subscribe?chain=solana&api_key=${encodeURIComponent(KEY)}`;
    const counts = {};
    const samples = {};
    const dexish = {};
    const meteora = [];
    let total = 0;
    let opened = false;
    let done = false;

    const ws = new WebSocket(url);

    function finish(note) {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) { /* already closed */ }

      if (!opened) {
        report('Blur stream', false, note);
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
          if (/dex|pool|protocol|program|venue/i.test(k) && typeof v === 'string') {
            if (!dexish[k]) dexish[k] = new Set();
            dexish[k].add(v);
          }
        }
        if (meteora.length < 3 && /meteora|dbc|damm/i.test(JSON.stringify(msg))) meteora.push(msg);
      }
    });

    ws.on('unexpected-response', (req, res) => {
      const code = res.statusCode;
      finish(`Handshake rejected with HTTP ${code}.` + (code === 403
        ? ' A plain key should include Blur access, so a 403 here while RPC passes is new information, paste this output back.'
        : ''));
    });

    ws.on('error', (err) => {
      finish('Connection error: ' + String(err.message).replace(/api_key=[^&\s]+/gi, 'api_key=<redacted>'));
    });

    ws.on('close', (code) => {
      if (!done) {
        finish(code === 4002
          ? 'Closed with code 4002: streaming balance exhausted, check Bandwidth in the Solami dashboard.'
          : `Closed by the server with code ${code}.`);
      }
    });
  });
}

console.log('Solami verification for Sela');
await checkRpc();
await checkBlur();
console.log('\nDone.');
process.exit(0);
