// activity-feed-widget.js
//
// Drop-in activity feed panel. Mounts into #activity-feed-mount (the
// real dashboard mount from MOUNTS.md) and polls
// /.netlify/functions/activity-feed. Falls back to #activityFeed for
// backward compatibility during the shim period; once this is
// confirmed working, tell Tunde so Session A can drop the shim in
// MOUNTS.md and this fallback can be removed.
//
// Always labels its data honestly: a clear "Mock data" badge when
// source is 'mock', "Live via Solami" plus the filters used when
// source is 'solami'. Uses the existing style.css tokens (--bg-card,
// --accent, --font-mono, .card). Inline SVG icons only, no emojis.
//
// Made by TJS Code

(function () {
  const ICONS = {
    swap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3v12M7 15l-3-3M7 15l3-3M17 21V9M17 9l3 3M17 9l-3 3"/></svg>',
    deposit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M12 19l-6-6M12 19l6-6"/></svg>',
    transfer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    withdrawal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg>',
    launch: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    meme: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>',
    graduation: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V6M6 12l6-6 6 6M5 21h14"/></svg>',
    liquidity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11z"/></svg>',
    other: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  };

  // Event text can come from token names typed on chain, so nothing is
  // ever put into the page as raw HTML.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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
    const icon = Object.prototype.hasOwnProperty.call(ICONS, ev.type) ? ICONS[ev.type] : ICONS.other;
    const amount = typeof ev.amountUsd === 'number' ? `$${ev.amountUsd.toFixed(2)}` : '';
    return `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid var(--border);">
        <div style="color:var(--accent);flex-shrink:0;">${icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.9rem;color:var(--text);">${esc(ev.label)}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">${esc(ev.detail)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${amount ? `<div style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text);">${amount}</div>` : ''}
          <div style="font-size:0.72rem;color:var(--text-muted);">${esc(relativeTime(ev.timestampMs))}</div>
        </div>
      </div>`;
  }

  function renderLabel(source, filters) {
    if (source === 'solami') {
      const parts = ['Live via Solami'];
      if (filters && filters.type) parts.push('type: ' + filters.type);
      if (filters && filters.dex) parts.push('dex: ' + filters.dex);
      if (filters && filters.address) parts.push('address: ' + String(filters.address).slice(0, 6) + '...');
      return `<div style="font-size:0.72rem;color:var(--accent);font-family:var(--font-mono);margin-bottom:0.5rem;">${parts.map(esc).join(' | ')}</div>`;
    }
    return `<div style="font-size:0.72rem;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:0.5rem;">Mock data, Solami not connected yet</div>`;
  }

  async function loadFeed(container) {
    try {
      const res = await fetch('/.netlify/functions/activity-feed');
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.events)) {
        container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">Activity feed unavailable.</div>`;
        return;
      }
      const label = renderLabel(data.source, data.filters);
      if (data.events.length === 0) {
        container.innerHTML = label + `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">No activity yet.</div>`;
        return;
      }
      container.innerHTML = label + data.events.map(renderEvent).join('');
    } catch (err) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">Activity feed unavailable.</div>`;
    }
  }

  function init() {
    const container = document.getElementById('activity-feed-mount') || document.getElementById('activityFeed');
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
