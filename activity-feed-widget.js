// activity-feed-widget.js
//
// Drop-in activity feed panel. Mounts into any element with
// id="activityFeed" and polls /.netlify/functions/activity-feed.
// Uses the existing design tokens from style.css (--bg-card, --accent,
// --font-mono, .card), so it matches the rest of the dashboard without
// its own stylesheet. Inline SVG icons only, no emojis.
//
// Usage: add <div id="activityFeed" class="card"></div> wherever the
// feed should appear (a new dashboard tab, a sidebar, etc), then
// include this script. Not yet wired into dashboard.html's tab nav,
// since that depends on the merged repo's final tab structure.
//
// Made by TJS Code

(function () {
  const ICONS = {
    swap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3v12M7 15l-3-3M7 15l3-3M17 21V9M17 9l3 3M17 9l-3 3"/></svg>',
    deposit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M12 19l-6-6M12 19l6-6"/></svg>',
    transfer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    withdrawal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg>',
    other: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  };

  function relativeTime(ms) {
    const diff = Math.max(0, Date.now() - ms);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function renderEvent(ev) {
    const icon = ICONS[ev.type] || ICONS.other;
    const amount = typeof ev.amountUsd === 'number' ? `$${ev.amountUsd.toFixed(2)}` : '';
    return `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid var(--border);">
        <div style="color:var(--accent);flex-shrink:0;">${icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.9rem;color:var(--text);">${ev.label}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">${ev.detail || ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${amount ? `<div style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text);">${amount}</div>` : ''}
          <div style="font-size:0.72rem;color:var(--text-muted);">${relativeTime(ev.timestampMs)}</div>
        </div>
      </div>`;
  }

  async function loadFeed(container) {
    try {
      const res = await fetch('/.netlify/functions/activity-feed');
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.events)) {
        container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">Activity feed unavailable.</div>`;
        return;
      }
      if (data.events.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">No activity yet.</div>`;
        return;
      }
      container.innerHTML = data.events.map(renderEvent).join('');
    } catch (err) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">Activity feed unavailable.</div>`;
    }
  }

  function init() {
    const container = document.getElementById('activityFeed');
    if (!container) return;
    loadFeed(container);
    setInterval(() => loadFeed(container), 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
