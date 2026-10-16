// passkey-bridge-client.js
//
// Lets a passkey step run in the phone's real browser when the app is
// open inside a wallet app's built-in browser, where WebAuthn does not
// work. The wallet browser keeps the wallet connection and everything
// else, only the passkey prompt is handed to Chrome or Safari:
//
//   1. this file asks /.netlify/functions/passkey-bridge for a one-time
//      request (the challenge to sign) and gets a short code back
//   2. it shows a card with a link to /passkey-bridge.html?code=...
//   3. the user opens that link in Chrome or Safari, approves with their
//      fingerprint or face, the page posts the signed answer back
//   4. this file polls until the answer arrives and returns it, so the
//      caller carries on exactly as if WebAuthn had run in place
//
// passkey-client.js loads this file on demand, only when native WebAuthn
// is missing. Where WebAuthn works (desktop, Chrome, Safari) it is never
// used.
//
// Made by TJS Code

const PasskeyBridge = (() => {
  const ENDPOINT = '/.netlify/functions/passkey-bridge';
  const POLL_MS = 1500;

  function _bytesToB64url(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function _el(tag, props, children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children || []) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  // Android can be told to open a link in Chrome specifically, with the
  // plain link as the fallback. Elsewhere the plain link is used.
  function _openLinks(code, url) {
    const isAndroid = /android/i.test(navigator.userAgent);
    if (!isAndroid) return { href: url, label: 'Open in your browser' };
    const intent = 'intent://' + location.host + '/passkey-bridge.html?code=' + encodeURIComponent(code) +
      '#Intent;scheme=' + location.protocol.replace(':', '') + ';package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    return { href: intent, label: 'Open in Chrome' };
  }

  function _openCard({ code, url, summary, onCancel }) {
    const css = (s) => s;
    const backdrop = _el('div', {});
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.style.cssText = css('position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;padding:1.25rem;font-family:var(--font-body,"Space Grotesk",sans-serif);');

    const card = _el('div', {});
    card.style.cssText = css('width:100%;max-width:420px;background:var(--bg-card,#0d1117);border:1px solid var(--border,#1f2937);border-radius:16px;padding:1.5rem;color:var(--text,#e5e7eb);');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '28'); icon.setAttribute('height', '28'); icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2');
    icon.style.cssText = 'color:var(--accent,#f59e0b);display:block;margin:0 auto 0.9rem;';
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p1.setAttribute('d', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z');
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p2.setAttribute('d', 'M9 12l2 2 4-4');
    icon.appendChild(p1); icon.appendChild(p2);

    const title = _el('div', { textContent: 'Approve in your browser' });
    title.style.cssText = 'text-align:center;font-weight:600;font-size:1.15rem;margin-bottom:0.5rem;';
    const body = _el('div', { textContent: "Passkeys can't run inside this wallet app. Open the button below in Chrome or Safari, approve with your fingerprint or face, then come back here. This screen continues by itself." });
    body.style.cssText = 'text-align:center;color:var(--text-muted,#9ca3af);font-size:0.88rem;line-height:1.55;margin-bottom:1rem;';

    const sum = _el('div', { textContent: summary || '' });
    sum.style.cssText = 'font-family:var(--font-mono,"JetBrains Mono",monospace);font-size:0.78rem;background:var(--bg,#05080f);border:1px solid var(--border,#1f2937);border-radius:10px;padding:0.65rem 0.8rem;margin-bottom:1rem;word-break:break-word;' + (summary ? '' : 'display:none;');

    const links = _openLinks(code, url);
    const open = _el('a', { href: links.href, textContent: links.label });
    open.setAttribute('rel', 'noopener');
    open.style.cssText = 'display:block;text-align:center;background:var(--accent,#f59e0b);color:#05080f;font-weight:600;border-radius:10px;padding:0.8rem 1rem;text-decoration:none;margin-bottom:0.6rem;';

    const copy = _el('button', { type: 'button', textContent: 'Copy link' });
    copy.style.cssText = 'display:block;width:100%;background:transparent;color:var(--text,#e5e7eb);border:1px solid var(--border,#1f2937);border-radius:10px;padding:0.7rem 1rem;font:inherit;cursor:pointer;margin-bottom:0.6rem;';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = 'Link copied, paste it in Chrome or Safari'; }
      catch (_) { copy.textContent = url; copy.style.fontSize = '0.7rem'; copy.style.wordBreak = 'break-all'; }
    });

    const status = _el('div', { textContent: 'Waiting for approval...' });
    status.style.cssText = 'text-align:center;color:var(--text-muted,#9ca3af);font-size:0.82rem;margin:0.5rem 0;min-height:1.2em;';

    const cancel = _el('button', { type: 'button', textContent: 'Cancel' });
    cancel.style.cssText = 'display:block;width:100%;background:transparent;color:var(--text-muted,#9ca3af);border:none;padding:0.5rem;font:inherit;cursor:pointer;';
    cancel.addEventListener('click', onCancel);

    [icon, title, body, sum, open, copy, status, cancel].forEach((n) => card.appendChild(n));
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    return { setStatus: (t) => { status.textContent = t; }, close: () => backdrop.remove() };
  }

  /**
   * type 'create': resolves { credentialId, publicKeySpki, clientDataJSON }
   * type 'get':    resolves { authenticatorData, clientDataJSON, signature }
   * all values base64url. Rejects with a readable Error on cancel, expiry
   * or a failed passkey step.
   */
  async function request({ type, challenge, credentialId, label, summary }) {
    const created = await fetch(ENDPOINT + '?action=create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        challenge: _bytesToB64url(challenge),
        credentialId: credentialId ? _bytesToB64url(credentialId) : undefined,
        label,
        summary,
      }),
    });
    const info = await created.json().catch(() => ({}));
    if (!created.ok || !info.code) throw new Error(info.error || 'Could not start the passkey handoff, try again.');

    const code = info.code;
    const url = location.origin + '/passkey-bridge.html?code=' + encodeURIComponent(code);
    let cancelled = false;
    const card = _openCard({ code, url, summary, onCancel: () => { cancelled = true; } });
    const deadline = (info.expiresAt || Date.now() + 5 * 60 * 1000) + 5000;

    try {
      for (;;) {
        if (cancelled) throw new Error('Cancelled.');
        if (Date.now() > deadline) throw new Error('The request expired. Start again.');
        await _sleep(POLL_MS);
        let res;
        try { res = await fetch(ENDPOINT + '?code=' + encodeURIComponent(code) + '&role=poll', { cache: 'no-store' }); }
        catch (_) { card.setStatus('Connection hiccup, still waiting...'); continue; }
        if (res.status === 404 || res.status === 410) throw new Error('The request expired. Start again.');
        const data = await res.json().catch(() => ({}));
        if (data.status === 'done') return data.result;
        if (data.status === 'error') throw new Error(data.error || 'The passkey step failed.');
        card.setStatus('Waiting for approval...');
      }
    } finally {
      card.close();
    }
  }

  return { request };
})();

window.PasskeyBridge = PasskeyBridge;
