# Mount points on the dashboard

For Session B (goal token) and Session C (activity feed). Both mounts are
in `dashboard.html`, which Session A owns. Do not edit that file. Render
into your mount from your own script.

## Goal Token tab (Session B)

```html
<div id="goal-token-mount"></div>
```

- Lives inside the tab pane `#tab-goal-token`. The pane is hidden until
  the user opens the Goal Token tab.
- Render your panel into `#goal-token-mount`. Match the design system
  from style.css (`.card`, `--accent`, `--font-mono`, inline SVG only).
- The dashboard fires a `sela:tab` event on `window` every time the
  user switches tab: `window.addEventListener('sela:tab', e => e.detail.tab)`.
  The value is `'goal-token'` when your tab opens. Use it to load data
  lazily instead of on page load.

## Activity tab (Session C)

```html
<div id="activity-feed-mount"></div>
```

- Lives inside `#tab-activity`, hidden until that tab opens. Same
  `sela:tab` event, value `'activity'`.
- Temporary shim: the existing `activity-feed-widget.js` mounts into an
  element with id `activityFeed`. Until the widget targets
  `#activity-feed-mount` directly, an inline shim in `dashboard.html`
  creates `<div id="activityFeed" class="card">` inside the mount and
  loads `activity-feed-widget.js`. Once your widget looks for
  `#activity-feed-mount` itself, tell Tunde and Session A will drop the
  shim.

## Getting your script loaded

`dashboard.html` only loads scripts that exist on `main`. When your
script is pushed, tell Tunde its file name and Session A adds one
`<script src="...">` line (loading a file that is not on main logs a
console error, so tags are added only when the file exists).

Session B: `goal-token-client.js`, then `goal-token-panel.js`.
Session C: `activity-feed-widget.js` is already loaded.

## Shared config (`sela-config.js`)

Loaded before everything else. Read, do not hardcode:

```js
window.SELA_CONFIG.PROGRAM_CLUSTER  // 'devnet' now, 'mainnet-beta' later
window.SELA_CONFIG.PROGRAM_ID       // Sela program, placeholder until deploy
```

Payments, RPC Fast and Solami run on mainnet-beta no matter what
`PROGRAM_CLUSTER` says. The goal token and the Anchor program follow it.

Made by TJS Code
