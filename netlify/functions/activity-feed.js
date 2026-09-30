// netlify/functions/activity-feed.js
//
// Serves the labeled activity feed to the frontend: { source, filters,
// events }. Never talks to a data provider directly, always goes
// through lib/activitySource.js so the provider can change without
// this file changing, and the frontend always knows whether it is
// looking at mock or live data.
//
// Frontend calls: /.netlify/functions/activity-feed
//
// Made by TJS Code

const { getActivityFeed } = require('../../lib/activitySource');
const { scrubSecrets } = require('../../lib/secretScrub');

exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { source, filters, events } = await getActivityFeed();
    return { statusCode: 200, headers, body: JSON.stringify({ source, filters, events }) };
  } catch (err) {
    console.error('activity-feed failure:', scrubSecrets(err && err.message));
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Activity feed unavailable.' }),
    };
  }
};
