// Sela goal token client. Plain browser JS, no build step.
// Talks to the goal-token Netlify functions and signs with the site's wallet adapter.
//
// Wallet contract this file expects (UNVERIFIED against wallet-adapter.js, which the session
// that wrote this could not read). Pass any object with:
//   publicKey            base58 string, or an object with toBase58()
//   signTransaction(tx)  takes a web3.js Transaction, resolves to the signed Transaction
// and load @solana/web3.js in the page as window.solanaWeb3. If the adapter differs, only
// signWithWallet() below needs to change.
(function (root) {
  'use strict';

  var BASE = '/.netlify/functions/';

  function post(fn, body) {
    return fetch(BASE + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(parse);
  }
  function get(fn, query) {
    var qs = Object.keys(query || {}).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&');
    return fetch(BASE + fn + (qs ? '?' + qs : ''), { headers: { Accept: 'application/json' } }).then(parse);
  }
  function parse(res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var err = new Error((data && data.error) || 'Request failed');
        err.status = res.status;
        throw err;
      }
      return data;
    });
  }

  function addressOf(wallet) {
    var pk = wallet && wallet.publicKey;
    if (!pk) throw new Error('Connect a wallet first');
    return typeof pk === 'string' ? pk : pk.toBase58();
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function signWithWallet(wallet, txBase64) {
    var web3 = root.solanaWeb3;
    if (!web3) return Promise.reject(new Error('solanaWeb3 is not loaded on this page'));
    if (!wallet || typeof wallet.signTransaction !== 'function') {
      return Promise.reject(new Error('This wallet cannot sign transactions'));
    }
    var tx = web3.Transaction.from(b64ToBytes(txBase64));
    return Promise.resolve(wallet.signTransaction(tx)).then(function (signed) {
      return bytesToB64(signed.serialize());
    });
  }

  function send(signedTxBase64) {
    return post('goal-token-send', { action: 'send', signedTxBase64: signedTxBase64 });
  }

  function waitForConfirmation(signature, opts) {
    var timeoutMs = (opts && opts.timeoutMs) || 60000;
    var started = Date.now();
    function tick() {
      return post('goal-token-send', { action: 'status', signature: signature }).then(function (s) {
        if (s.state === 'failed') throw new Error('Transaction failed on chain' + (s.error ? ': ' + s.error : ''));
        if (s.state === 'confirmed' || s.state === 'finalized') return s;
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for confirmation');
        return new Promise(function (r) { setTimeout(r, 2000); }).then(tick);
      });
    }
    return tick();
  }

  // Creates the goal token: build, sign, send, confirm, then register.
  function createGoalToken(wallet, p) {
    var creator = addressOf(wallet);
    var built;
    return post('goal-token-create', {
      goalId: p.goalId, creator: creator, goalAmountUsdc: p.goalAmountUsdc, name: p.name, symbol: p.symbol,
    }).then(function (b) {
      built = b;
      return signWithWallet(wallet, b.txBase64);
    }).then(send).then(function (r) {
      return waitForConfirmation(r.signature).then(function () { return r.signature; });
    }).then(function (signature) {
      return post('goal-token-registry', {
        goalId: p.goalId, creator: creator, poolAddress: built.poolAddress, mintAddress: built.mintAddress,
        configAddress: built.configAddress, name: built.name, symbol: built.symbol,
        goalAmountUsdc: built.goalAmountUsdc, signature: signature,
      }).then(function () { return { signature: signature, poolAddress: built.poolAddress, mintAddress: built.mintAddress }; });
    });
  }

  function quoteBuy(wallet, p) {
    return post('goal-token-buy', { action: 'quote', goalId: p.goalId, buyer: addressOf(wallet), amountUsdc: p.amountUsdc, slippageBps: p.slippageBps });
  }

  function buy(wallet, p) {
    return post('goal-token-buy', { action: 'build', goalId: p.goalId, buyer: addressOf(wallet), amountUsdc: p.amountUsdc, slippageBps: p.slippageBps })
      .then(function (b) { return signWithWallet(wallet, b.txBase64); })
      .then(send)
      .then(function (r) { return waitForConfirmation(r.signature).then(function () { return r.signature; }); });
  }

  function status(goalId) {
    return get('goal-token-status', { goalId: goalId });
  }

  root.SelaGoalToken = {
    createGoalToken: createGoalToken,
    quoteBuy: quoteBuy,
    buy: buy,
    status: status,
    signWithWallet: signWithWallet,
    waitForConfirmation: waitForConfirmation,
  };
})(typeof window !== 'undefined' ? window : globalThis);
