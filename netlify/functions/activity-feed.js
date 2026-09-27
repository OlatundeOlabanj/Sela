// netlify/functions/activity-feed.js
//
// Serves the normalized activity feed to the frontend. Never talks to
// a data provider directly, always goes through lib/activitySource.js
// so the provider can change without this file changing.
//
// Frontend calls: /.netlify/functions/activity-feed
//
// Made by TJS Code

const { getActivityFeed } = require('../../lib/activitySource');

exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const events = await getActivityFeed();
    return { statusCode: 200, headers, body: JSON.stringify({ events }) };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Activity feed unavailable: ' + err.message }),
    };
  }
};
