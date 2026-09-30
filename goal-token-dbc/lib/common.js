'use strict';
// Shared helpers for the goal token Netlify functions. Pure JS, no dependencies,
// so it can be unit tested offline.
//
// All cluster dependent values read PROGRAM_CLUSTER (default devnet). Switching to mainnet
// is a config change, not a rewrite.

const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'; // same on devnet and mainnet

const CLUSTERS = {
  devnet: {
    name: 'devnet',
    quoteMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Circle devnet USDC
    defaultRpc: 'https://api.devnet.solana.com',
    explorerSuffix: '?cluster=devnet',
  },
  'mainnet-beta': {
    name: 'mainnet-beta',
    quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    defaultRpc: 'https://api.mainnet-beta.solana.com',
    explorerSuffix: '',
  },
};

const USDC_DECIMALS = 6;

// Placeholder marker written into the config until the Cognata program is deployed.
const UNRESOLVED_MARKER = 'CANNOT_RESOLVE_UNTIL_DEPLOY';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58DecodedLength(str) {
  // Returns the byte length of a base58 string, or -1 if it has an invalid character.
  let bytes = [];
  for (let i = 0; i < str.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(str[i]);
    if (idx < 0) return -1;
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) leadingZeros++;
  return bytes.length + leadingZeros;
}

function isValidAddress(str) {
  return typeof str === 'string' && str.length >= 32 && str.length <= 44 && base58DecodedLength(str) === 32;
}

function getCluster(env) {
  const name = (env && env.PROGRAM_CLUSTER) || 'devnet';
  const cluster = CLUSTERS[name];
  if (!cluster) {
    throw new HttpError(500, 'PROGRAM_CLUSTER must be "devnet" or "mainnet-beta", got "' + name + '"');
  }
  return Object.assign({}, cluster, { rpcUrl: (env && env.GOAL_TOKEN_RPC_URL) || cluster.defaultRpc });
}

// Reads the treasury address from the environment. Fails closed: if it is missing, malformed,
// or still the unresolved marker, we refuse rather than fall back to some other wallet.
function getTreasuryAddress(env) {
  const value = env && env.GOAL_TREASURY_ADDRESS;
  if (!value || value.indexOf(UNRESOLVED_MARKER) === 0) {
    throw new HttpError(
      503,
      'GOAL_TREASURY_ADDRESS is not set. It is the Treasury PDA (seeds [b"treasury"] under the ' +
        'deployed Cognata program ID) and cannot be known until the program is deployed.'
    );
  }
  if (!isValidAddress(value)) {
    throw new HttpError(500, 'GOAL_TREASURY_ADDRESS is not a valid Solana address');
  }
  return value;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function respond(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function handleError(err) {
  if (err instanceof HttpError) return respond(err.status, { error: err.message });
  // Never echo internals or anything that could contain a secret.
  console.error('goal-token error:', err && err.message ? err.message : 'unknown');
  return respond(500, { error: 'Internal error' });
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function requireAddress(value, field) {
  if (!isValidAddress(value)) throw new HttpError(400, field + ' must be a valid Solana address');
  return value;
}

function requireGoalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new HttpError(400, 'goalId must be 1 to 64 characters: letters, digits, underscore, hyphen');
  }
  return value;
}

// Converts a decimal USDC string or number to base units (integer string) without float error.
function usdcToBaseUnits(amount) {
  const s = typeof amount === 'number' ? String(amount) : amount;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new HttpError(400, 'amount must be a positive number with at most 6 decimal places');
  }
  const parts = s.split('.');
  const frac = ((parts[1] || '') + '000000').slice(0, USDC_DECIMALS);
  const units = (parts[0] + frac).replace(/^0+(?=\d)/, '');
  if (units === '0') throw new HttpError(400, 'amount must be greater than zero');
  return units;
}

module.exports = {
  DBC_PROGRAM_ID,
  CLUSTERS,
  USDC_DECIMALS,
  UNRESOLVED_MARKER,
  HttpError,
  isValidAddress,
  getCluster,
  getTreasuryAddress,
  respond,
  handleError,
  parseBody,
  requireAddress,
  requireGoalId,
  usdcToBaseUnits,
};
