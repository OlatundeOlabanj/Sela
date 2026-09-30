'use strict';
// GET /.netlify/functions/goal-token-metadata?g=<goalId>&n=<name>&s=<symbol>
// Serves the token metadata JSON that the pool's uri points at. Static fields only, built from
// the query string, so it works before the registry entry exists. No image yet, see RUNBOOK.md.

const C = require('../../goal-token-dbc/lib/common');

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const name = String(q.n || 'Sela goal token').slice(0, 32);
  const symbol = String(q.s || 'GOAL').slice(0, 10);
  const body = {
    name,
    symbol,
    description:
      'Contribution receipt for a Sela shared savings goal. It can trade once the goal is met. ' +
      'Prices can fall. Not investment advice.',
    external_url: process.env.URL || '',
  };
  return {
    statusCode: 200,
    headers: Object.assign({}, C.respond(200, {}).headers, { 'Cache-Control': 'public, max-age=300' }),
    body: JSON.stringify(body),
  };
};
