// rpc-status-pill.js
//
// Small live status pill showing which RPC provider is serving mainnet
// and how fast it answered a real getSlot call, measured server side by
// /.netlify/functions/rpc-health. Nothing here is hardcoded: if the
// health check fails, the pill says so instead of showing a claim.
//
// Mounts into <div id="rpc-status-mount"></div> if the page has one.
// Uses the style.css tokens (--accent, --border, --text-muted,
// --font-mono). Inline SVG only, no emojis.
//
// Made by TJS Code

(function () {
  const ENDPOINT = '/.netlify/functions/rpc-health';
  const REFRESH_MS = 30000;

  function build(mount) {
    mount.textContent = '';
    const pill = document.createElement('span');
    pill.style.cssText =
      'display:inline-flex;align-items:center;gap:0.5rem;font-family:var(--font-mono);' +
      'font-size:0.72rem;color:var(--text-muted);border:1px solid var(--border);' +
      'border-radius:100px;padding:3px 10px;';
    pill.setAttribute('role', 'status');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '12');
    icon.setAttribute('height', '12');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.style.color = 'var(--accent)';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M13 2L4 14h7l-1 8 9-12h-7l1-8z');
    icon.appendChild(path);

    const label = document.createElement('span');
    label.textContent = 'Checking mainnet RPC';

    pill.appendChild(icon);
    pill.appendChild(label);
    mount.appendChild(pill);
    return { pill, label };
  }

  async function refresh(ui) {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error('unhealthy');
      const parts = ['Mainnet RPC: ' + d.provider];
      if (d.region) parts.push(d.region);
      parts.push(d.latencyMs + ' ms');
      parts.push('slot ' + Number(d.slot).toLocaleString('en-US'));
      ui.label.textContent = parts.join(' | ');
      ui.pill.title = 'Measured server side with real getSlot calls (median of ' + d.samples + ')';
    } catch (_) {
      ui.label.textContent = 'Mainnet RPC status unavailable';
      ui.pill.title = 'The live health check did not respond';
    }
  }

  function init() {
    const mount = document.getElementById('rpc-status-mount');
    if (!mount) return;
    const ui = build(mount);
    refresh(ui);
    setInterval(() => refresh(ui), REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
