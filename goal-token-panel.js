// Sela goal token panel. Mounts into #goal-token-mount.
//
// Reads from the mount element:
//   data-goal-id       required, the goal's id
//   data-goal-name     used to prefill the token name
//   data-goal-amount   goal target in USDC, used when starting a goal token
// Wallet: window.SelaWallet by default (UNVERIFIED name, confirm against wallet-adapter.js),
// or pass { getWallet: function () { return wallet; } } to mount().
// Requires goal-token-client.js to be loaded first. DOM is built with textContent only.
(function (root) {
  'use strict';

  var CSS =
    '.gt{font-family:"Space Grotesk",system-ui,sans-serif;background:#111113;color:#ece7dc;border:1px solid #2a2620;border-radius:14px;padding:20px;max-width:520px}' +
    '.gt *{box-sizing:border-box}' +
    '.gt-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}' +
    '.gt-head svg{width:22px;height:22px;flex:none}' +
    '.gt-title{font-size:18px;font-weight:600;margin:0}' +
    '.gt-badge{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid #f5b93a;color:#f5b93a;white-space:nowrap}' +
    '.gt-bar{height:10px;background:#22201b;border-radius:999px;overflow:hidden;margin:10px 0 6px}' +
    '.gt-fill{height:100%;background:linear-gradient(90deg,#c98a14,#f5b93a);width:0;transition:width .4s}' +
    '.gt-row{display:flex;justify-content:space-between;font-family:"JetBrains Mono",monospace;font-size:13px;color:#b9b2a3}' +
    '.gt-form{margin-top:16px;display:grid;gap:10px}' +
    '.gt label{font-size:12px;color:#b9b2a3}' +
    '.gt input{width:100%;background:#0b0b0c;border:1px solid #2f2a22;border-radius:8px;color:#ece7dc;padding:10px 12px;font-family:"JetBrains Mono",monospace;font-size:14px}' +
    '.gt input:focus{outline:none;border-color:#f5b93a}' +
    '.gt button{background:#f5b93a;color:#111113;border:0;border-radius:8px;padding:11px 14px;font-family:inherit;font-weight:600;font-size:14px;cursor:pointer}' +
    '.gt button:disabled{opacity:.5;cursor:not-allowed}' +
    '.gt-quote{font-family:"JetBrains Mono",monospace;font-size:12px;color:#f5b93a;min-height:16px}' +
    '.gt-msg{font-size:13px;margin-top:10px;color:#b9b2a3}' +
    '.gt-msg.err{color:#ff8a6b}' +
    '.gt-links{display:flex;gap:14px;margin-top:14px;font-size:13px}' +
    '.gt-links a{color:#f5b93a;text-decoration:none;display:inline-flex;align-items:center;gap:5px}' +
    '.gt-links svg{width:13px;height:13px}' +
    '.gt-note{margin-top:16px;padding-top:12px;border-top:1px solid #2a2620;font-size:12px;line-height:1.5;color:#8d877a}';

  var ICON_COIN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#f5b93a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.6-1 1.5-2.5 1.6-2.5.6-2.5 1.6 1 1.6 2.5 1.6 2.5-.6 2.5-1.6"/></svg>';
  var ICON_LINK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

  var DISCLOSURE =
    'Goal tokens are contribution receipts. They can trade once the goal is met, prices can fall, ' +
    'and you can lose what you put in. This is not investment advice.';

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function svg(markup) {
    var t = document.createElement('span');
    t.innerHTML = markup; // static markup defined in this file, never user input
    return t.firstChild;
  }
  function safeExplorer(url) {
    return typeof url === 'string' && url.indexOf('https://explorer.solana.com/') === 0 ? url : null;
  }
  function suggestSymbol(name) {
    var s = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    return s.length >= 2 ? s : 'GOAL';
  }

  function mount(el, opts) {
    opts = opts || {};
    if (!el) return null;
    if (!document.getElementById('gt-style')) {
      var st = document.createElement('style');
      st.id = 'gt-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var goalId = el.getAttribute('data-goal-id');
    var goalName = el.getAttribute('data-goal-name') || 'Sela goal';
    var goalAmount = Number(el.getAttribute('data-goal-amount')) || 0;
    var getWallet = opts.getWallet || function () { return root.SelaWallet; };
    var client = root.SelaGoalToken;
    var timer = null;
    var quoteTimer = null;
    var busy = false;
    var view = null; // { state, fill, left, right } for in place updates while a user is typing

    var box = h('div', { class: 'gt' });
    el.textContent = '';
    el.appendChild(box);

    function head(badge) {
      var kids = [svg(ICON_COIN), h('h3', { class: 'gt-title', text: 'Goal token' })];
      if (badge) kids.push(h('span', { class: 'gt-badge', text: badge }));
      return h('div', { class: 'gt-head' }, kids);
    }
    function note() { return h('p', { class: 'gt-note', text: DISCLOSURE }); }
    function msg(text, isErr) { return h('div', { class: 'gt-msg' + (isErr ? ' err' : ''), text: text }); }

    function renderNotCreated(message) {
      var name = h('input', { type: 'text', id: 'gt-name', maxlength: '32', value: goalName });
      var symbol = h('input', { type: 'text', id: 'gt-symbol', maxlength: '10', value: suggestSymbol(goalName) });
      var out = h('div');
      var btn = h('button', {
        text: 'Start goal token',
        onclick: function () {
          if (busy) return;
          var wallet = getWallet();
          busy = true; btn.disabled = true;
          out.textContent = '';
          out.appendChild(msg('Waiting for your wallet, then confirming on chain...'));
          client.createGoalToken(wallet, { goalId: goalId, goalAmountUsdc: goalAmount, name: name.value, symbol: symbol.value })
            .then(function () { busy = false; view = null; refresh(); })
            .catch(function (e) { busy = false; btn.disabled = false; out.textContent = ''; out.appendChild(msg(e.message, true)); });
        },
      });
      box.textContent = '';
      box.appendChild(head('Not started'));
      box.appendChild(h('div', { class: 'gt-msg', text: message || ('Turn this goal into a token members buy into with USDC. Target: ' + goalAmount + ' USDC.') }));
      box.appendChild(h('div', { class: 'gt-form' }, [
        h('label', { for: 'gt-name', text: 'Token name' }), name,
        h('label', { for: 'gt-symbol', text: 'Symbol' }), symbol,
        btn, out,
      ]));
      box.appendChild(note());
    }

    function stateOf(s) { return s.migrated ? 'migrated' : (s.thresholdReached ? 'reached' : 'open'); }

    function renderStatus(s) {
      var badge = s.migrated ? 'Graduated' : (s.thresholdReached ? 'Goal reached' : 'Open');
      box.textContent = '';
      box.appendChild(head(badge));
      var fill = h('div', { class: 'gt-fill' });
      fill.style.width = Math.max(0, Math.min(100, s.progressPct)) + '%';
      box.appendChild(h('div', { class: 'gt-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(s.progressPct) }, [fill]));
      var left = h('span', { text: s.raisedUsdc + ' USDC raised' });
      var right = h('span', { text: 'of ' + s.targetUsdc + ' (' + s.progressPct + '%)' });
      box.appendChild(h('div', { class: 'gt-row' }, [left, right]));
      view = { state: stateOf(s), fill: fill, left: left, right: right };

      if (s.migrated) {
        box.appendChild(msg('This goal has graduated. The token now trades on a DAMM v2 pool.'));
      } else if (s.thresholdReached) {
        box.appendChild(msg('The goal amount is reached. Graduation to a DAMM v2 pool is pending.'));
      } else {
        var amount = h('input', { type: 'text', inputmode: 'decimal', id: 'gt-amount', placeholder: '10', value: '10' });
        var quote = h('div', { class: 'gt-quote' });
        var out = h('div');
        var btn = h('button', {
          text: 'Buy in',
          onclick: function () {
            if (busy) return;
            busy = true; btn.disabled = true; out.textContent = '';
            out.appendChild(msg('Waiting for your wallet, then confirming on chain...'));
            client.buy(getWallet(), { goalId: goalId, amountUsdc: amount.value })
              .then(function () { busy = false; out.textContent = ''; out.appendChild(msg('Bought in. Updating progress.')); refresh(); })
              .catch(function (e) { busy = false; btn.disabled = false; out.textContent = ''; out.appendChild(msg(e.message, true)); });
          },
        });
        function requote() {
          clearTimeout(quoteTimer);
          quote.textContent = '';
          quoteTimer = setTimeout(function () {
            if (!getWallet() || !getWallet().publicKey) { quote.textContent = 'Connect a wallet to see a quote'; return; }
            client.quoteBuy(getWallet(), { goalId: goalId, amountUsdc: amount.value })
              .then(function (q) { quote.textContent = 'You receive about ' + (Number(q.expectedTokenUnits) / Math.pow(10, q.tokenDecimals)).toLocaleString() + ' tokens'; })
              .catch(function (e) { quote.textContent = e.message; });
          }, 400);
        }
        amount.addEventListener('input', requote);
        box.appendChild(h('div', { class: 'gt-form' }, [h('label', { for: 'gt-amount', text: 'Amount in USDC' }), amount, quote, btn, out]));
        requote();
      }

      var links = [];
      var pool = safeExplorer(s.explorerPoolUrl);
      var mint = safeExplorer(s.explorerMintUrl);
      if (pool) links.push(h('a', { href: pool, target: '_blank', rel: 'noopener noreferrer' }, [svg(ICON_LINK), h('span', { text: 'Pool' })]));
      if (mint) links.push(h('a', { href: mint, target: '_blank', rel: 'noopener noreferrer' }, [svg(ICON_LINK), h('span', { text: 'Token' })]));
      if (links.length) box.appendChild(h('div', { class: 'gt-links' }, links));
      box.appendChild(note());
    }

    function refresh() {
      if (busy) return;
      client.status(goalId).then(function (s) {
        if (!s.registered || !s.poolFound) { view = null; renderNotCreated(); return; }
        if (view && view.state === stateOf(s)) {
          // Same state: update numbers in place so a half typed amount is not wiped.
          view.fill.style.width = Math.max(0, Math.min(100, s.progressPct)) + '%';
          view.left.textContent = s.raisedUsdc + ' USDC raised';
          view.right.textContent = 'of ' + s.targetUsdc + ' (' + s.progressPct + '%)';
          return;
        }
        renderStatus(s);
      }).catch(function (e) { renderNotCreated('Could not load the goal token: ' + e.message); });
    }

    if (!goalId) { box.appendChild(msg('Missing data-goal-id on the mount element.', true)); return null; }
    refresh();
    timer = setInterval(function () { if (!busy) refresh(); }, 20000);
    return { refresh: refresh, destroy: function () { clearInterval(timer); clearTimeout(quoteTimer); el.textContent = ''; } };
  }

  root.SelaGoalTokenPanel = { mount: mount };
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var el = document.getElementById('goal-token-mount');
      if (el && root.SelaGoalToken) mount(el);
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
