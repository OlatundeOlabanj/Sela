'use strict';
// Goal id to pool mapping, stored in Netlify Blobs. One record per goal per cluster.
// UNVERIFIED against invoice-store.js: that file was not available to the session that wrote
// this one, so the store bootstrap in openStore() may need to match its pattern.

const { HttpError } = require('./common');

function key(cluster, goalId) {
  return cluster + ':' + goalId;
}

function openStore() {
  const { getStore } = require('@netlify/blobs');
  return getStore('goal-token-registry');
}

async function getRecord(store, cluster, goalId) {
  const rec = await store.get(key(cluster, goalId), { type: 'json' });
  return rec || null;
}

// First write wins. A second registration for the same goal is rejected, never overwritten.
async function putRecord(store, cluster, record) {
  const k = key(cluster, record.goalId);
  const existing = await store.get(k, { type: 'json' });
  if (existing) throw new HttpError(409, 'A goal token is already registered for this goal');
  await store.setJSON(k, record);
  return record;
}

module.exports = { openStore, getRecord, putRecord, key };
