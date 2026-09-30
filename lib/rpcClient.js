// lib/rpcClient.js
//
// Resolves the Solana RPC endpoint from environment variables,
// independent of which provider is behind it. Every server side RPC
// call (rpc-proxy, rpc-health, submit-bundle) goes through here, so
// swapping providers is a Netlify env var change, not a code change.
//
// Mainnet: set RPC_HTTP_URL to the full endpoint URL your provider
// gives you. RPC Fast's dashboard issues one per app, with the auth
// key already inside the URL. Legacy fallback: HELIUS_API_KEY alone
// still works. Once RPC_HTTP_URL is set it always wins.
//
// Devnet: DEVNET_RPC_URL, defaulting to the public devnet endpoint.
// RPC Fast's free plan is mainnet only, so devnet never uses it.
//
// Nothing in this file ever returns a URL to a browser. The helpers
// that describe the provider (getProviderInfo) expose a name and an
// optional label only, never the URL or the key.
//
// Made by TJS Code

const PUBLIC_DEVNET_URL = 'https://api.devnet.solana.com';
const CLUSTERS = ['mainnet-beta', 'devnet'];

function getRpcUrl() {
  const directUrl = process.env.RPC_HTTP_URL;
  if (directUrl) return directUrl;

  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

  throw new Error('No RPC endpoint configured: set RPC_HTTP_URL (preferred) or HELIUS_API_KEY.');
}

// cluster is validated against a fixed list. A caller can pick a
// cluster by name but can never supply a URL, which keeps the proxy
// from being used to reach arbitrary hosts.
function isValidCluster(cluster) {
  return CLUSTERS.includes(cluster);
}

function getRpcUrlForCluster(cluster) {
  if (!isValidCluster(cluster)) {
    throw new Error('Unknown cluster. Use one of: ' + CLUSTERS.join(', '));
  }
  if (cluster === 'devnet') return process.env.DEVNET_RPC_URL || PUBLIC_DEVNET_URL;
  return getRpcUrl();
}

// Describes the mainnet provider without exposing the URL or key.
// The name comes from the hostname only. RPC_REGION_LABEL is an
// optional env var (for example "Frankfurt") so the label is only
// shown when it has actually been set by a person who knows it.
function getProviderInfo() {
  const url = new URL(getRpcUrl());
  const host = url.hostname.toLowerCase();
  let name = 'Custom RPC';
  if (host.includes('rpcfast')) name = 'RPC Fast';
  else if (host.includes('helius')) name = 'Helius';
  else if (host.includes('solami')) name = 'Solami';
  return { name, region: process.env.RPC_REGION_LABEL || null };
}

module.exports = { getRpcUrl, getRpcUrlForCluster, getProviderInfo, isValidCluster, CLUSTERS };
