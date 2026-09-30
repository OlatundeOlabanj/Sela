// lib/secretScrub.js
//
// Node's low-level fetch/WebSocket connection errors (DNS failure,
// ECONNREFUSED, TLS errors, etc) can embed the full request URL in
// err.message, and RPC/Solami URLs carry their auth key in the query
// string. Secrets must never reach logs, not just client responses
// (see the project's own rule), so every place that might log or
// rethrow such an error message runs it through this first.
//
// Made by TJS Code

const KEY_PARAM_PATTERN = /([?&](?:api[_-]?key|token|access_token|key)=)[^&\s"']+/gi;

function scrubSecrets(message) {
  return String(message == null ? '' : message).replace(KEY_PARAM_PATTERN, '$1<redacted>');
}

module.exports = { scrubSecrets };
