/**
 * VeilPay, Main Application Logic
 * Made by TJS Code
 */

// ─── UUID Generator ────────────────────────────────────────────────────────────

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── LocalStorage Helpers ──────────────────────────────────────────────────────

const INVOICE_PREFIX = 'veilpay_invoice_';
const INVOICE_INDEX  = 'veilpay_invoice_index';

async function saveInvoice(invoice) {
  try {
    localStorage.setItem(`${INVOICE_PREFIX}${invoice.id}`, JSON.stringify(invoice));
    // Maintain an index of invoice IDs
    const index = getInvoiceIndex();
    if (!index.includes(invoice.id)) {
      index.unshift(invoice.id); // newest first
      localStorage.setItem(INVOICE_INDEX, JSON.stringify(index));
    }
    // Write-through to the real backend so the invoice is retrievable
    // from any device, not just this browser. Awaited (not fire-and-forget)
    // so a caller that needs ordering guarantees (e.g. updateInvoiceStatus
    // right after invoice creation on the same device) can be sure this
    // write actually landed before firing the next one. Without this, a
    // slow "create" write could land on the server AFTER a fast "mark as
    // paid" write and silently revert the invoice back to pending.
    try {
      await fetch('/api/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoice)
      });
    } catch (err) {
      console.error('[VeilPay] Failed to sync invoice to server:', err);
    }
    return true;
  } catch (err) {
    console.error('[VeilPay] Failed to save invoice:', err);
    return false;
  }
}

async function getInvoice(id) {
  // Try local cache first. Instant if this is the device that created it.
  try {
    const raw = localStorage.getItem(`${INVOICE_PREFIX}${id}`);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('[VeilPay] Failed to read invoice from cache:', err);
  }
  // Fall back to the real backend. This is what makes invoices work
  // when opened on a different device than the one that created them.
  try {
    const res = await fetch(`/api/invoice?id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const invoice = await res.json();
    // Cache it locally too, so a second view on this device is instant.
    localStorage.setItem(`${INVOICE_PREFIX}${id}`, JSON.stringify(invoice));
    return invoice;
  } catch (err) {
    console.error('[VeilPay] Failed to fetch invoice from server:', err);
    return null;
  }
}

function getInvoiceLocal(id) {
  try {
    const raw = localStorage.getItem(`${INVOICE_PREFIX}${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[VeilPay] Failed to read invoice from cache:', err);
    return null;
  }
}

function getAllInvoices() {
  const index = getInvoiceIndex();
  return index.map(id => getInvoiceLocal(id)).filter(Boolean);
}

function getInvoiceIndex() {
  try {
    const raw = localStorage.getItem(INVOICE_INDEX);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function updateInvoiceStatus(id, status, extra = {}) {
  const invoice = await getInvoice(id);
  if (!invoice) return false;
  Object.assign(invoice, { status, ...extra });
  return saveInvoice(invoice);
}

// ─── Wallet State ──────────────────────────────────────────────────────────────

const WalletState = {
  _key: 'veilpay_wallet',

  get() {
    try {
      const raw = sessionStorage.getItem(this._key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  set(data) {
    try {
      // Only store serializable fields, never the provider object
      const safe = { publicKey: data.publicKey, truncated: data.truncated, walletName: data.walletName };
      sessionStorage.setItem(this._key, JSON.stringify(safe));
    } catch (err) {
      console.error('[VeilPay] Failed to save wallet state:', err);
    }
  },

  clear() {
    sessionStorage.removeItem(this._key);
  },

  isConnected() {
    return !!this.get()?.publicKey;
  }
};

// ─── URL Params Parser ─────────────────────────────────────────────────────────

function getURLParam(key) {
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}

// ─── Copy to Clipboard ────────────────────────────────────────────────────────

async function copyToClipboard(text, triggerEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers that block clipboard without user interaction
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  if (triggerEl) {
    showCopyFeedback(triggerEl);
  }

  showToast('Copied to clipboard', 'amber');
}

function showCopyFeedback(el) {
  // Add relative positioning if not already
  const original = el.style.position;
  if (!['relative', 'absolute', 'fixed'].includes(getComputedStyle(el).position)) {
    el.style.position = 'relative';
  }

  const tip = document.createElement('div');
  tip.className = 'copy-tooltip';
  tip.textContent = 'Copied!';
  el.appendChild(tip);

  setTimeout(() => {
    tip.remove();
    el.style.position = original;
  }, 1600);
}

// ─── WhatsApp Share ────────────────────────────────────────────────────────────

function shareViaWhatsApp(invoiceLink, clientName, amount) {
  const text = `Hi ${clientName || 'there'}, here is your VeilPay invoice for ${amount} USDC. Pay securely via this private link: ${invoiceLink}`;
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── Toast System ─────────────────────────────────────────────────────────────

let _toastContainer = null;

function getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.querySelector('.toast-container');
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.className = 'toast-container';
      document.body.appendChild(_toastContainer);
    }
  }
  return _toastContainer;
}

function showToast(message, type = 'amber', duration = 3500) {
  const container = getToastContainer();

  const icons = {
    amber: `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    green: `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    red:   `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.amber}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ─── Date Formatter ────────────────────────────────────────────────────────────

function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return isoString;
  }
}

function formatAmount(amount) {
  return Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ─── Truncate Wallet ──────────────────────────────────────────────────────────

function truncateWallet(key) {
  if (!key || key.length < 10) return key || '';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ─── Status Badge HTML ────────────────────────────────────────────────────────

function statusBadge(status) {
  const map = {
    pending:  { cls: 'badge-pending',  label: 'Pending' },
    paid:     { cls: 'badge-paid',     label: 'Paid'    },
    expired:  { cls: 'badge-expired',  label: 'Expired' },
    disputed: { cls: 'badge-expired',  label: 'Disputed' },
  };
  const s = map[status] || map.pending;
  return `<span class="badge ${s.cls}"><span class="badge-dot"></span>${s.label}</span>`;
}

// ─── Invoice Card Renderer ────────────────────────────────────────────────────

function renderInvoiceCard(invoice, payLink) {
  const link = payLink || `${window.location.origin}/pay.html?id=${invoice.id}`;
  const shortId = (invoice.id || '').slice(0, 8).toUpperCase();
  const fee = Number(invoice.amount || 0) * 0.02;
  const net = Number(invoice.amount || 0) * 0.98;
  return `
    <div class="invoice-card" data-id="${invoice.id}">
      <div class="invoice-card-header">
        <div>
          <div class="invoice-number">INV-${shortId}</div>
          <div class="invoice-client">${escapeHtml(invoice.clientName)}</div>
        </div>
        ${statusBadge(invoice.status)}
      </div>

      <div class="invoice-divider"></div>

      <div class="invoice-lineitem">
        <div class="invoice-lineitem-desc">${escapeHtml(invoice.description)}</div>
        <div class="invoice-lineitem-amount">${formatAmount(invoice.amount)} USDC</div>
      </div>

      <div class="invoice-feebreakdown">
        <span>Platform fee (2%)</span><span>-${formatAmount(fee)} USDC</span>
      </div>
      <div class="invoice-feebreakdown invoice-feebreakdown-net">
        <span>You receive</span><span>${formatAmount(net)} USDC</span>
      </div>

      <div class="invoice-divider"></div>

      <div class="invoice-meta-row">
        <span>Issued ${formatDate(invoice.createdAt)}</span>
        ${invoice.dueDate ? `<span>Due ${formatDate(invoice.dueDate)}</span>` : ''}
      </div>

      <div class="invoice-footer">
        <div class="invoice-actions">
          <button class="btn btn-ghost btn-sm" onclick="copyInvoiceLink('${invoice.id}')" style="position:relative;">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy Link
          </button>
          <a href="${link}" target="_blank" class="btn btn-ghost btn-sm">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            View
          </a>
          ${invoice.status === 'disputed'
            ? `<button class="btn btn-ghost btn-sm" style="color:var(--success);" onclick="handleResolveDispute('${invoice.id}')">
                <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                Resolve
              </button>`
            : invoice.status !== 'paid'
            ? `<button class="btn btn-ghost btn-sm" style="color:#f59e0b;" onclick="handleDisputeInvoice('${invoice.id}')">
                <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Dispute
              </button>`
            : ''}
        </div>
      </div>
    </div>
  `;
}

function copyInvoiceLink(invoiceId) {
  const link = `${window.location.origin}/pay.html?id=${invoiceId}`;
  copyToClipboard(link);
}

// Make globally accessible
window.copyInvoiceLink = copyInvoiceLink;

// ─── Empty State HTML ──────────────────────────────────────────────────────────

function renderEmptyState() {
  return `
    <div class="empty-state">
      <svg width="64" height="64" fill="none" viewBox="0 0 24 24" stroke="#6b7280" stroke-width="1.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
      <h4>No invoices yet</h4>
      <p>Create your first invoice using the form on the left.</p>
    </div>
  `;
}

// ─── HTML Escaping ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const wrapper = document.createElement('div');
  wrapper.className = 'confetti-wrapper';
  document.body.appendChild(wrapper);

  const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#f97316'];
  const count = 60;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      width: ${4 + Math.random() * 8}px;
      height: ${4 + Math.random() * 8}px;
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-duration: ${1.8 + Math.random() * 2}s;
      animation-delay: ${Math.random() * 0.6}s;
    `;
    wrapper.appendChild(piece);
  }

  setTimeout(() => wrapper.remove(), 5000);
}

// ─── Wallet Connection UI Helper ──────────────────────────────────────────────

async function connectWalletUI({ onSuccess, onError } = {}) {
  if (!window.VeilWalletAdapter) {
    showToast('Wallet adapter failed to load. Please refresh the page.', 'red');
    return null;
  }
  window.VeilWalletAdapter.showPicker({
    async onConnect(entry) {
      try {
        const result = await VeilEngine.connectWallet(entry);
        WalletState.set(result);
        if (onSuccess) onSuccess(result);
      } catch (err) {
        const msg = err.message || 'Failed to connect wallet';
        showToast(msg, 'red', 5000);
        if (onError) onError(err);
      }
    },
  });
  return null;
}

/** Silent reconnect on page load: re-fetches the previously-connected wallet's
 *  live provider by name without opening the picker or prompting a fresh
 *  approval. Returns null (not an error) if that wallet is no longer
 *  available, the caller falls back to showing the cached address only. */
async function reconnectWalletSilently(walletName) {
  if (!walletName) return null;
  try {
    return await VeilEngine.connectWallet(walletName);
  } catch (err) {
    console.warn('[VeilPay] Silent reconnect failed:', err.message);
    return null;
  }
}

// ─── Modal Helpers ─────────────────────────────────────────────────────────────

function openModal(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.add('active');
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.remove('active');
}

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// Close modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});


// ─── Dispute Flag ─────────────────────────────────────────────────────────────

async function flagDispute(id, reason) {
  const invoice = await getInvoice(id);
  if (!invoice) return false;
  invoice.disputed = true;
  invoice.disputeReason = reason || 'No reason provided';
  invoice.disputedAt = new Date().toISOString();
  invoice.status = 'disputed';
  return saveInvoice(invoice);
}

async function resolveDispute(id) {
  const invoice = await getInvoice(id);
  if (!invoice) return false;
  invoice.disputed = false;
  invoice.disputeReason = null;
  invoice.resolvedAt = new Date().toISOString();
  invoice.status = 'pending';
  return saveInvoice(invoice);
}

// ─── Subscription / Recurring Invoice ────────────────────────────────────────

const SUB_PREFIX = 'veilpay_sub_';
const SUB_INDEX  = 'veilpay_sub_index';

function saveSubscription(sub) {
  try {
    localStorage.setItem(`${SUB_PREFIX}${sub.id}`, JSON.stringify(sub));
    const index = getSubIndex();
    if (!index.includes(sub.id)) {
      index.unshift(sub.id);
      localStorage.setItem(SUB_INDEX, JSON.stringify(index));
    }
    return true;
  } catch (err) {
    console.error('[VeilPay] Failed to save subscription:', err);
    return false;
  }
}

function getSubIndex() {
  try {
    const raw = localStorage.getItem(SUB_INDEX);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getAllSubscriptions() {
  return getSubIndex().map(id => {
    try {
      const raw = localStorage.getItem(`${SUB_PREFIX}${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }).filter(Boolean);
}

function createSubscription({ clientName, description, amount, recipientWallet, intervalDays }) {
  const sub = {
    id: generateUUID(),
    clientName,
    description,
    amount,
    recipientWallet,
    intervalDays: intervalDays || 30,
    status: 'active',
    createdAt: new Date().toISOString(),
    nextDueAt: new Date(Date.now() + (intervalDays || 30) * 86400000).toISOString(),
    invoicesGenerated: 0,
  };
  saveSubscription(sub);
  return sub;
}

function pauseSubscription(id) {
  try {
    const raw = localStorage.getItem(`${SUB_PREFIX}${id}`);
    if (!raw) return false;
    const sub = JSON.parse(raw);
    sub.status = 'paused';
    localStorage.setItem(`${SUB_PREFIX}${id}`, JSON.stringify(sub));
    return true;
  } catch { return false; }
}

function renderSubscriptionCard(sub) {
  const nextDue = formatDate(sub.nextDueAt);
  const statusColor = sub.status === 'active' ? 'var(--success)' : 'var(--text-muted)';
  return `
    <div class="invoice-card" data-sub-id="${sub.id}">
      <div class="invoice-card-header">
        <div>
          <div class="invoice-client">${escapeHtml(sub.clientName)}</div>
          <div style="font-size:0.78rem;color:var(--text-dim);margin-top:2px;">Every ${sub.intervalDays} days · Next: ${nextDue}</div>
        </div>
        <div style="text-align:right;">
          <div class="invoice-amount">${formatAmount(sub.amount)} USDC</div>
          <div style="margin-top:4px;font-size:0.75rem;font-weight:600;color:${statusColor};">${sub.status.toUpperCase()}</div>
        </div>
      </div>
      <div class="invoice-desc">${escapeHtml(sub.description)}</div>
      <div class="invoice-footer">
        <div class="invoice-actions">
          <button class="btn btn-ghost btn-sm" onclick="generateSubInvoice('${sub.id}')">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            Generate Invoice
          </button>
          <button class="btn btn-ghost btn-sm" onclick="pauseSubUI('${sub.id}')">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
            </svg>
            ${sub.status === 'active' ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>
    </div>`;
}

window.generateSubInvoice = function(subId) {
  try {
    const raw = localStorage.getItem(`${SUB_PREFIX}${subId}`);
    if (!raw) return;
    const sub = JSON.parse(raw);
    const invoiceId = generateUUID();
    const invoice = {
      id: invoiceId,
      clientName: sub.clientName,
      description: sub.description + ' (Recurring)',
      amount: sub.amount,
      recipientWallet: sub.recipientWallet,
      status: 'pending',
      createdAt: new Date().toISOString(),
      payLink: `${window.location.origin}/pay.html?id=${invoiceId}`,
      fromSubscription: subId,
    };
    saveInvoice(invoice);
    sub.invoicesGenerated = (sub.invoicesGenerated || 0) + 1;
    sub.nextDueAt = new Date(Date.now() + sub.intervalDays * 86400000).toISOString();
    localStorage.setItem(`${SUB_PREFIX}${subId}`, JSON.stringify(sub));
    showToast('Invoice generated from subscription!', 'green');
    copyToClipboard(invoice.payLink);
  } catch (err) {
    showToast('Failed: ' + err.message, 'red');
  }
};

window.pauseSubUI = function(subId) {
  pauseSubscription(subId);
  showToast('Subscription paused.', 'amber');
};


// ─── Expose globally ──────────────────────────────────────────────────────────
//
// Named Cognata, not VeilPay: every call site across dashboard.html,
// pay.html, tos.html and goals-tab.js already calls Cognata.xxx (a
// side effect of the VeilPay-to-Cognata rebrand pass early in this
// project, which renamed those call sites in the HTML files' inline
// scripts but never updated this export to match, since this file
// wasn't touched by that pass). That mismatch meant window.Cognata
// was undefined this whole time, every one of those ~100 call sites
// has been throwing since the rebrand, this is likely the real reason
// the dashboard has looked broken. Fixing the export name here, to
// match everything that already expects it, rather than renaming
// ~100 call sites back.

window.Cognata = {
  generateUUID,
  saveInvoice,
  getInvoice,
  getAllInvoices,
  updateInvoiceStatus,
  WalletState,
  getURLParam,
  copyToClipboard,
  shareViaWhatsApp,
  showToast,
  formatDate,
  formatAmount,
  truncateWallet,
  statusBadge,
  renderInvoiceCard,
  renderEmptyState,
  escapeHtml,
  launchConfetti,
  connectWalletUI,
  reconnectWalletSilently,
  openModal,
  closeModal,
  flagDispute,
  resolveDispute,
  createSubscription,
  getAllSubscriptions,
  renderSubscriptionCard,
};
