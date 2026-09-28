// lib/rpcClient.js
//
// Resolves the Solana mainnet RPC endpoint from environment variables,
// independent of which provider is behind it. Both rpc-proxy.js and
// submit-bundle.js import this instead of building a provider URL
// themselves, so swapping providers is a Netlify env var change, not
// a code change.
//
// Preferred: set RPC_HTTP_URL to the full endpoint URL your provider
// gives you. RPC Fast's dashboard issues one per app (already
// including the auth token in the URL). Point it at that.
//
// Legacy fallback: HELIUS_API_KEY alone still works, so existing
// deployments keep running until RPC_HTTP_URL is set. Once RPC_HTTP_URL
// is set it always wins, regardless of whether HELIUS_API_KEY is
// still present.
//
// Made by TJS Code

function getRpcUrl() {
  const directUrl = process.env.RPC_HTTP_URL;
  if (directUrl) return directUrl;

  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

  throw new Error('No RPC endpoint configured: set RPC_HTTP_URL (preferred) or HELIUS_API_KEY.');
}

module.exports = { getRpcUrl };
