// Phone Guard Store Admin
const ADMIN_PASSWORD = 'guard123';
const API_BASE = 'https://phoneguardstore-api.stawisystems.workers.dev';
const ADMIN_TOKEN = atob('b1VtbXlDanhYakg3RmhBbWFqdmktWFBQZlhnLW5BZVRxb2d3X3FNMDI2NA==');

let bags = [];
let settings = {};
let clients = []; // manually-added clients (server-synced); sale buyers are derived separately
let editingId = null;
let stagedImage = null; // { base64, ext, dataUrl }
let pendingSaleId = null;
let pendingRestockId = null;

// ====== AUTH ======
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginBtn = document.getElementById('loginBtn');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

function checkAuth() {
  if (sessionStorage.getItem('ryker_auth') === '1') {
    loginScreen.style.display = 'none';
    dashboard.style.display = 'block';
    init();
  }
}
loginBtn.addEventListener('click', login);
loginPassword.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
async function login() {
  const pw = loginPassword.value;
  // Server check first: accepts the owner password (hashed in KV) OR the agency
  // master (Joel@123 / fleet token, server-only). Falls back to the built-in
  // owner password client-side if the worker is unreachable, so a hiccup never
  // locks the owner out.
  let ok = false;
  try {
    const r = await fetch(`${API_BASE}/api/check-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const j = await r.json();
    ok = !!j.ok;
  } catch (_) {}
  if (!ok && pw === ADMIN_PASSWORD) ok = true;
  if (ok) {
    sessionStorage.setItem('ryker_auth', '1');
    loginError.style.display = 'none';
    checkAuth();
  } else {
    loginError.style.display = 'block';
  }
}
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('ryker_auth');
  location.reload();
});

// ====== CHANGE PASSWORD ======
document.getElementById('changePasswordBtn')?.addEventListener('click', () => {
  const m = document.getElementById('changePasswordModal');
  if (!m) return;
  m.style.display = 'flex';
  ['cpCurrent', 'cpNew', 'cpConfirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('cpError').style.display = 'none';
  document.getElementById('cpCurrent')?.focus();
});
function _closeChangePassword() { const m = document.getElementById('changePasswordModal'); if (m) m.style.display = 'none'; }
document.getElementById('cpCancelBtn')?.addEventListener('click', _closeChangePassword);
document.getElementById('changePasswordModal')?.addEventListener('click', e => { if (e.target.id === 'changePasswordModal') _closeChangePassword(); });
document.getElementById('cpSaveBtn')?.addEventListener('click', async () => {
  const cur = document.getElementById('cpCurrent').value;
  const nw = document.getElementById('cpNew').value;
  const cf = document.getElementById('cpConfirm').value;
  const err = document.getElementById('cpError');
  err.style.display = 'none';
  if (!cur) { err.textContent = 'Enter your current password.'; err.style.display = 'block'; return; }
  if (nw.length < 8) { err.textContent = 'New password must be at least 8 characters.'; err.style.display = 'block'; return; }
  if (nw !== cf) { err.textContent = 'New password and confirmation do not match.'; err.style.display = 'block'; return; }
  const btn = document.getElementById('cpSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // Verify the current password (server-side: stored hash OR agency master), with an offline fallback.
    let curOk = false;
    try {
      const cr = await fetch(`${API_BASE}/api/check-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: cur }),
      });
      curOk = !!(await cr.json()).ok;
    } catch (_) {}
    if (!curOk && cur === ADMIN_PASSWORD) curOk = true;
    if (!curOk) { err.textContent = 'Current password is wrong.'; err.style.display = 'block'; return; }
    // Set the new password (SHA-256 hashed server-side under KV "adminpass").
    const res = await fetch(`${API_BASE}/api/set-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ password: nw }),
    });
    const j = await res.json();
    if (j.ok) {
      _closeChangePassword();
      showToast('Password changed. You stay signed in; the new password takes effect on next login.');
    } else {
      err.textContent = j.error || 'Could not change password.'; err.style.display = 'block';
    }
  } catch (e) {
    err.textContent = 'Network error: ' + (e.message || e); err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Change password';
  }
});

// ====== API ======
// Billing kill-switch: when the store is suspended the owner can still VIEW the
// admin but every write is frozen. The worker is the real gate (403); these
// client guards surface a clean message instead of a raw error. `accountSuspended`
// is set by loadData() from /api/bags.
const SUSPENDED_MSG = 'Your store is offline. Contact Essence Automations to restore it before making changes.';

async function apiUploadImage(base64, ext) {
  if (accountSuspended) throw new Error(SUSPENDED_MSG);
  const res = await fetch(`${API_BASE}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ base64, ext }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Upload failed: ${res.status}`); }
  const data = await res.json();
  return `${API_BASE}${data.path}`;
}

// Low-level publish of the current in-memory `bags`. Do NOT call directly for
// user-triggered writes — go through apiMutateAndPublish so a stale list can't
// clobber the live catalogue.
async function apiPublish() {
  const res = await fetch(`${API_BASE}/api/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ bags, settings, clients }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Save failed: ${res.status}`); }
}

// Every admin write MUST go through this. It refetches live KV, applies the
// caller's mutation against the FRESH list, then publishes — so a stale admin
// tab (or a second device/webview) can't silently resurrect deleted items or
// revert edits by republishing an old list. (This was Joyce's "everything came
// back" bug.) Mutators MUST look up bags by id INSIDE the callback — anything
// captured before the refetch is stale. A mutator may throw to abort the save.
async function apiMutateAndPublish(mutate) {
  if (accountSuspended) throw new Error(SUSPENDED_MSG);
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  if (!res.ok) throw new Error(`Failed to load fresh data: ${res.status}`);
  const json = await res.json();
  bags = Array.isArray(json.bags) ? json.bags : [];
  settings = json.settings || {};
  clients = Array.isArray(json.clients) ? json.clients : [];
  await mutate();
  await apiPublish();
}

let accountSuspended = false;
async function loadData() {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  const json = await res.json();
  bags = json.bags || [];
  settings = json.settings || {};
  clients = Array.isArray(json.clients) ? json.clients : [];
  accountSuspended = !!json.suspended;
}

// Owner-facing notice when billing has suspended the store. The public site is
// dark; this tells the owner why and how to restore (they can't unflip it).
function renderSuspendedBanner() {
  let b = document.getElementById('suspendedBanner');
  if (!accountSuspended) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'suspendedBanner';
    b.style.cssText = 'position:sticky;top:0;z-index:9000;background:#b00020;color:#fff;padding:12px 16px;text-align:center;font-size:14px;font-weight:600;line-height:1.4;';
    document.body.prepend(b);
  }
  b.innerHTML = 'Your store is offline. You can still view everything here, but changes are frozen until it is restored. Contact Essence Automations to bring it back online. <a href="https://wa.me/254720615606" style="color:#fff;text-decoration:underline;">Message us</a>';
}

// ====== HELPERS ======
const toast = document.getElementById('toast');
function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2800); }

// In-page confirm. Native confirm() returns false without showing in in-app
// webviews (WhatsApp/Instagram browser) and after Chrome's "block additional
// dialogs", which silently aborted deletes for the owner.
function confirmAction(message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmModalMsg');
    const okBtn = document.getElementById('confirmModalOk');
    const cancelBtn = document.getElementById('confirmModalCancel');
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    modal.style.display = 'flex';
    const cleanup = result => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// In-page category picker. Same reason as confirmAction — native prompt() is
// suppressed in in-app webviews. Lists existing categories (avoids typos) with
// a "+ New category…" escape hatch. Resolves to the chosen name, or null.
function chooseCategory() {
  return new Promise(resolve => {
    const modal = document.getElementById('categoryModal');
    const sel = document.getElementById('categoryModalSelect');
    const newWrap = document.getElementById('categoryModalNewWrap');
    const newInput = document.getElementById('categoryModalNew');
    const okBtn = document.getElementById('categoryModalOk');
    const cancelBtn = document.getElementById('categoryModalCancel');
    const cats = [...new Set(bags.map(b => b.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
      + '<option value="__new__">+ New category…</option>';
    newWrap.style.display = 'none';
    newInput.value = '';
    modal.style.display = 'flex';
    const onSelChange = () => {
      const isNew = sel.value === '__new__';
      newWrap.style.display = isNew ? '' : 'none';
      if (isNew) newInput.focus();
    };
    const cleanup = result => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      sel.removeEventListener('change', onSelChange);
      resolve(result);
    };
    const onOk = () => cleanup((sel.value === '__new__' ? newInput.value.trim() : sel.value) || null);
    const onCancel = () => cleanup(null);
    sel.addEventListener('change', onSelChange);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function setSaving(on) {
  const btn = document.getElementById('saveBtn');
  btn.disabled = on;
  btn.textContent = on ? 'Publishing…' : 'Save item';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtKsh(n) { return 'Ksh ' + Number(n || 0).toLocaleString('en-KE'); }

function totalStock(item) {
  if (!item.stock) return 0;
  return Object.values(item.stock).reduce((s, q) => s + (Number(q) || 0), 0);
}

function isSoldOut(item) { return totalStock(item) === 0; }

function allSales(item) { return item.sales || []; }

function totalUnitsSold(item) {
  return allSales(item).reduce((s, r) => s + (Number(r.qty) || 1), 0);
}

function totalRevenue(item) {
  return allSales(item).reduce((s, r) => s + (Number(r.salePrice || item.price) * (Number(r.qty) || 1)), 0);
}

// ====== IMAGES ======
// Downscale + re-encode every picked/downloaded image to a compact JPEG before
// upload. WhatsApp link previews silently skip heavy images (a 2.3MB PNG won't
// render in the Enquire share card), so normalising covers to JPEG ~q82 at
// <=1280px keeps the preview working and the catalogue fast. Transparency is
// flattened onto white. All staged images become ext 'jpg'.
function blobToStagedJpeg(blob, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.split(',')[1], ext: 'jpg', dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const costInput = document.getElementById('costInput');
imageInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    stagedImage = await blobToStagedJpeg(file);
    imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:180px;border-radius:8px;margin-top:4px;">`;
  } catch (_) { showToast('Could not read that image. Try another file.'); }
});

// Additional images: array of { base64, ext, dataUrl } OR { url } (already-uploaded)
let stagedExtras = [];
const extraImagesInput = document.getElementById('extraImagesInput');
const extraImagesPreview = document.getElementById('extraImagesPreview');

function readFileAsStaged(file) { return blobToStagedJpeg(file); }

extraImagesInput?.addEventListener('change', async e => {
  const files = [...e.target.files];
  for (const f of files) {
    if (stagedExtras.length >= 8) break;
    try {
      const staged = await readFileAsStaged(f);
      stagedExtras.push(staged);
    } catch (_) {}
  }
  renderExtraImagesPreview();
  e.target.value = ''; // allow re-selecting the same file
});

function renderExtraImagesPreview() {
  if (!extraImagesPreview) return;
  if (!stagedExtras.length) { extraImagesPreview.innerHTML = ''; return; }
  extraImagesPreview.innerHTML = stagedExtras.map((s, i) => `
    <div class="extra-img-thumb">
      <img src="${s.dataUrl || s.url}" alt="Additional image ${i + 1}">
      <button class="extra-img-remove" data-extra-remove="${i}" aria-label="Remove" title="Remove">×</button>
    </div>
  `).join('');
  extraImagesPreview.querySelectorAll('[data-extra-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.extraRemove, 10);
      stagedExtras.splice(idx, 1);
      renderExtraImagesPreview();
    });
  });
}

// ====== IG QUICK-ADD ======
// State: when a user fetches via IG, we hold the post URL so it's saved on the item.
let stagedInstagramUrl = '';

document.getElementById('igQuickBtn')?.addEventListener('click', async () => {
  const url = document.getElementById('igQuickInput').value.trim();
  const status = document.getElementById('igQuickStatus');
  if (!url) { status.textContent = 'Paste an Instagram URL first.'; status.className = 'ig-quick-status err'; return; }
  if (!/instagram\.com\/(?:p|reel|tv)\//i.test(url)) { status.textContent = 'That doesn\'t look like an IG post URL.'; status.className = 'ig-quick-status err'; return; }

  status.textContent = 'Fetching from Instagram…';
  status.className = 'ig-quick-status';

  try {
    const r = await fetch(`${API_BASE}/api/ig-fetch?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Fetch failed');

    // Download the cover (first image) through the worker proxy — IG CDN blocks
    // direct browser fetches with CORS, so we hop via /api/ig-proxy which adds ACAO.
    async function downloadAndStage(imgUrl) {
      const proxied = `${API_BASE}/api/ig-proxy?url=${encodeURIComponent(imgUrl)}`;
      const r = await fetch(proxied);
      if (!r.ok) throw new Error('Image download failed');
      return blobToStagedJpeg(await r.blob());
    }

    stagedImage = await downloadAndStage(data.imageUrl);
    imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:180px;border-radius:8px;margin-top:4px;">`;

    // If carousel, download additional images too
    stagedExtras = [];
    const extras = (data.imageUrls || []).slice(1);
    if (extras.length) {
      status.textContent = `Downloading ${extras.length} more image${extras.length === 1 ? '' : 's'}…`;
      for (const u of extras) {
        try { stagedExtras.push(await downloadAndStage(u)); } catch (_) {}
      }
      renderExtraImagesPreview();
    }

    // Auto-fill description from caption (strip the "username" prefix some IG embeds add)
    const cap = (data.caption || '').replace(/^[a-z0-9._]+\s+/i, '').trim();
    document.getElementById('descInput').value = cap;

    // Suggest a name from the first sentence
    if (!document.getElementById('nameInput').value && cap) {
      const firstLine = cap.split(/[.!?\n]/)[0].trim().slice(0, 60);
      document.getElementById('nameInput').value = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
    }

    stagedInstagramUrl = data.postUrl;
    status.textContent = '✓ Image and caption loaded. Review the name, category, price and stock, then Save.';
    status.className = 'ig-quick-status ok';
  } catch (err) {
    status.textContent = '✗ ' + err.message + ' — paste image and write description manually instead.';
    status.className = 'ig-quick-status err';
  }
});

// ====== STOCK READ/WRITE ======
function getStockFromForm() {
  const stock = {};
  document.querySelectorAll('.stock-qty').forEach(inp => {
    const size = (inp.dataset.size || inp.value && inp.previousElementSibling?.value || '').trim();
    // For custom-size rows the size NAME is in a sibling text input; the qty input has data-size empty
    if (inp.classList.contains('stock-qty-custom')) return;  // handled below
    const val = parseInt(inp.value, 10);
    if (size && !isNaN(val) && val > 0) stock[size] = val;
  });
  // Custom rows: pair the size-name input with the qty input
  document.querySelectorAll('.custom-size-row').forEach(row => {
    const name = row.querySelector('.custom-size-name')?.value.trim();
    const qty = parseInt(row.querySelector('.custom-size-qty')?.value, 10);
    if (name && !isNaN(qty) && qty > 0) stock[name] = qty;
  });
  return stock;
}

// Sizes the standard fixed grids already cover (so we know what's "custom")
const FIXED_GRID_SIZES = new Set([
  'One Size',
  'XS','S','M','L','XL','XXL','3XL','4XL','5XL',
  '28','29','30','31','32','33','34','35','36','37','38','39','40','41','42','43','44',
  'UK6','UK7','UK8','UK9','UK10','UK11','UK12'
]);

function setStockToForm(stock) {
  document.querySelectorAll('.stock-qty').forEach(inp => {
    const size = inp.dataset.size;
    inp.value = stock && size && stock[size] > 0 ? stock[size] : '';
  });
  // Repopulate custom rows from any sizes that aren't in the fixed grid
  const customWrap = document.getElementById('customSizeRows');
  if (customWrap) {
    customWrap.innerHTML = '';
    if (stock) {
      Object.entries(stock).forEach(([size, qty]) => {
        if (qty > 0 && !FIXED_GRID_SIZES.has(size)) addCustomSizeRow(size, qty);
      });
    }
  }
}

function clearStockForm() {
  document.querySelectorAll('.stock-qty').forEach(inp => { inp.value = ''; });
  const customWrap = document.getElementById('customSizeRows');
  if (customWrap) customWrap.innerHTML = '';
}

// ====== CUSTOM SIZE ROWS ======
function addCustomSizeRow(name = '', qty = '') {
  const wrap = document.getElementById('customSizeRows');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'custom-size-row';
  row.innerHTML = `
    <input type="text" class="custom-size-name" placeholder="Size name (e.g. EU 42, Free Size)" value="${escapeHtml(name)}">
    <input type="number" min="0" step="1" class="custom-size-qty" placeholder="Qty" value="${qty || ''}">
    <button type="button" class="btn-admin danger custom-size-remove" aria-label="Remove">×</button>
  `;
  row.querySelector('.custom-size-remove').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}
document.getElementById('addCustomSizeBtn')?.addEventListener('click', () => addCustomSizeRow());

// ====== AI DESCRIPTION ======
document.getElementById('aiBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const cat = getCategoryValue();
  if (!name) { showToast('Enter the item name first.'); return; }
  document.getElementById('descInput').value = generateDescription(name, cat);
});

function generateDescription(name, cat) {
  const lower = name.toLowerCase();
  const colors = { black: 'sleek black', white: 'crisp white', navy: 'deep navy', grey: 'cool grey', gray: 'cool grey', blue: 'rich blue', brown: 'warm brown', khaki: 'classic khaki', beige: 'warm beige', cream: 'soft cream', olive: 'olive green', red: 'bold red' };
  let color = '';
  for (const c in colors) if (lower.includes(c)) { color = colors[c]; break; }

  const catMap = {
    'Phone Cases': 'phone case', 'iPad Cases': 'iPad case', 'Tablet Cases': 'tablet case',
    'MacBook Cases': 'MacBook case', 'Screen Protectors': 'screen protector', Accessories: 'accessory',
  };
  const type = catMap[cat] || 'piece';

  const openers = [
    `Protect your device with this ${color || 'quality'} ${type}. Slim, strong and ready to fit.`,
    `A clean ${color || 'reliable'} ${type}, brand new in stock.`,
    `${color ? color.charAt(0).toUpperCase() + color.slice(1) : 'Premium'} ${type}, brand new. Built to last and easy on the eyes.`,
  ];
  const mids = [
    `Brand new, quality-checked before listing.`,
    `Fresh in. Every detail done right.`,
    `Top-quality, ready to ship countrywide.`,
  ];
  const closes = [
    `Tap Check availability to chat with us on WhatsApp.`,
    `Tell us your device model and we'll confirm the fit.`,
    `Pick up at Iconic Business Plaza, Moi Avenue, or we deliver countrywide.`,
  ];
  return [openers[Math.floor(Math.random() * openers.length)], mids[Math.floor(Math.random() * mids.length)], closes[Math.floor(Math.random() * closes.length)]].join(' ');
}

// ====== SAVE ITEM ======
document.getElementById('saveBtn').addEventListener('click', saveItem);
document.getElementById('cancelBtn').addEventListener('click', resetForm);

async function saveItem() {
  const name = document.getElementById('nameInput').value.trim();
  const priceRaw = document.getElementById('priceInput').value.trim();
  const price = priceRaw === '' ? 0 : parseInt(priceRaw, 10);
  const desc = document.getElementById('descInput').value.trim();
  const category = getCategoryValue();
  const stock = getStockFromForm();

  if (!name) { showToast('Item name is required.'); return; }
  if (isNaN(price) || price < 0) { showToast('Price must be a number (or leave blank for "Price on request").'); return; }

  // Sale price (markdown): optional, must be a positive number below the price.
  const salePriceRaw = document.getElementById('itemSalePriceInput').value.trim();
  let itemSalePrice = null;
  if (salePriceRaw !== '') {
    itemSalePrice = parseInt(salePriceRaw, 10);
    if (isNaN(itemSalePrice) || itemSalePrice <= 0) { showToast('Sale price must be a positive number, or leave it blank.'); return; }
    if (itemSalePrice >= price) { showToast('Sale price must be lower than the regular price.'); return; }
  }

  // Buying price (cost) — admin-only, optional, never rejected. Blank/0 = not recorded.
  const costRaw = costInput.value.trim();
  const cost = costRaw === '' ? 0 : Math.max(0, parseInt(costRaw, 10) || 0);

  setSaving(true);
  try {
    let imagePath = null;
    if (stagedImage) {
      showToast('Uploading image…');
      imagePath = await apiUploadImage(stagedImage.base64, stagedImage.ext);
    }

    // Upload any newly-added extras (ones with base64), keep already-uploaded ones (.url)
    let extraUrls = [];
    if (stagedExtras.length) {
      showToast(`Uploading ${stagedExtras.length} additional image${stagedExtras.length === 1 ? '' : 's'}…`);
      for (const s of stagedExtras) {
        if (s.url) { extraUrls.push(s.url); continue; }
        const p = await apiUploadImage(s.base64, s.ext);
        extraUrls.push(p);
      }
    }

    if (editingId) {
      // Read the form's cleared/zeroed sizes now (DOM), apply to the FRESH bag in the mutator.
      const clearedSizes = [];
      document.querySelectorAll('.stock-qty').forEach(inp => {
        const val = parseInt(inp.value, 10);
        if ((!isNaN(val) && val === 0) || inp.value === '') clearedSizes.push(inp.dataset.size);
      });
      await apiMutateAndPublish(() => {
        const bag = bags.find(b => b.id === editingId);
        if (!bag) throw new Error('Item no longer exists — refresh admin');
        bag.name = name;
        bag.category = category;
        bag.description = desc;
        bag.price = price;
        bag.stock = { ...bag.stock, ...stock };
        // On edit, additional images = whatever is currently in stagedExtras (which we pre-populated from the bag)
        bag.images = extraUrls.length ? [imagePath || bag.image, ...extraUrls] : (imagePath ? [imagePath] : (bag.images || []));
        // Strip the lead since image field stays as the primary
        if (bag.images.length) bag.images = bag.images.filter((u, i, a) => u && a.indexOf(u) === i);
        // Remove sizes explicitly cleared/zeroed in the form
        clearedSizes.forEach(sz => { delete bag.stock[sz]; });
        if (imagePath) bag.image = imagePath;
        if (itemSalePrice) bag.salePrice = itemSalePrice; else delete bag.salePrice;
        if (cost) bag.cost = cost; else delete bag.cost;
      });
      showToast('Item updated and live!');
    } else {
      if (!stagedImage) { showToast('Add an item image.'); setSaving(false); return; }
      const id = 'item_' + Date.now();
      const newBag = { id, name, category, description: desc, price, stock, sales: [], image: imagePath, createdAt: new Date().toISOString() };
      if (extraUrls.length) newBag.images = [imagePath, ...extraUrls];
      if (stagedInstagramUrl) newBag.instagramUrl = stagedInstagramUrl;
      if (itemSalePrice) newBag.salePrice = itemSalePrice;
      if (cost) newBag.cost = cost;
      await apiMutateAndPublish(() => { bags.unshift(newBag); });
      showToast('Item added and live!');
    }
    resetForm();
    renderList();
    renderDashboard();
    renderInventory();
  } catch (err) {
    showToast('Error: ' + err.message);
    console.error(err);
  } finally {
    setSaving(false);
  }
}

// ===== Category field helpers =====
// The form category <select> is a fixed list, but the shop owner can add their
// own. Picking "+ Add new category…" reveals a free-text box; any category that
// already exists on an item is auto-injected so it shows up for everyone after.
function toggleNewCategoryInput() {
  const sel = document.getElementById('categoryInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel || !box) return;
  if (sel.value === '__new__') {
    box.style.display = '';
    box.focus();
  } else {
    box.style.display = 'none';
    box.value = '';
  }
}

// Read the chosen category, resolving the "+ Add new…" free-text path.
function getCategoryValue() {
  const sel = document.getElementById('categoryInput');
  if (!sel) return '';
  if (sel.value === '__new__') {
    return document.getElementById('categoryNewInput').value.trim();
  }
  return sel.value || '';
}

// Set the select to a category, injecting it as an option if it isn't a
// built-in one (so editing a custom-category item shows it selected).
function setCategoryValue(cat) {
  const sel = document.getElementById('categoryInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel) return;
  if (box) { box.style.display = 'none'; box.value = ''; }
  const c = cat || '';
  if (!c) { sel.value = ''; return; }
  const exists = [...sel.options].some(o => o.value === c);
  if (!exists) ensureCategoryOption(c);
  sel.value = c;
}

// Ensure a category exists as a <option> in the select. Custom (owner-added)
// categories land in a dedicated "Your categories" group above "+ Add new…".
function ensureCategoryOption(cat) {
  const sel = document.getElementById('categoryInput');
  if (!sel || !cat) return;
  if ([...sel.options].some(o => o.value === cat)) return;
  let group = document.getElementById('customCatGroup');
  if (!group) {
    group = document.createElement('optgroup');
    group.id = 'customCatGroup';
    group.label = 'Your categories';
    const newOpt = [...sel.options].find(o => o.value === '__new__');
    sel.insertBefore(group, newOpt || null);
  }
  const opt = document.createElement('option');
  opt.value = cat;
  opt.textContent = cat;
  group.appendChild(opt);
}

// Sweep every category already used on an item into the dropdown, so an
// owner-added category becomes a permanent choice for all future items.
// Works for flat OR optgroup selects: the built-in option values are
// snapshotted once (before any custom injection) so we never re-classify
// a built-in as custom.
let _builtinCatValues = null;
function syncCustomCategories() {
  const sel = document.getElementById('categoryInput');
  if (!sel) return;
  if (!_builtinCatValues) {
    _builtinCatValues = new Set([...sel.options].map(o => o.value).filter(v => v && v !== '__new__'));
  }
  [...new Set(bags.map(b => b.category).filter(Boolean))]
    .filter(c => !_builtinCatValues.has(c))
    .sort((a, b) => a.localeCompare(b))
    .forEach(ensureCategoryOption);
}

function resetForm() {
  editingId = null;
  document.getElementById('editingId').value = '';
  document.getElementById('nameInput').value = '';
  setCategoryValue('');
  document.getElementById('descInput').value = '';
  document.getElementById('priceInput').value = '';
  document.getElementById('itemSalePriceInput').value = '';
  costInput.value = '';
  clearStockForm();
  imageInput.value = '';
  imagePreview.innerHTML = '';
  stagedImage = null;
  stagedExtras = [];
  renderExtraImagesPreview();
  stagedInstagramUrl = '';
  const igInput = document.getElementById('igQuickInput');
  if (igInput) igInput.value = '';
  const igStatus = document.getElementById('igQuickStatus');
  if (igStatus) { igStatus.textContent = ''; igStatus.className = 'ig-quick-status'; }
  document.getElementById('formTitle').textContent = 'Add a new item';
  document.getElementById('cancelBtn').style.display = 'none';
  // Restore the IG quick-add panel + divider (hidden during edit mode)
  const igPanel = document.getElementById('igQuickPanel');
  const manualDivider = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = '';
  if (manualDivider) manualDivider.style.display = '';
}

function editItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  editingId = id;
  document.getElementById('editingId').value = id;
  document.getElementById('nameInput').value = bag.name;
  setCategoryValue(bag.category || '');
  document.getElementById('descInput').value = bag.description || '';
  document.getElementById('priceInput').value = bag.price;
  document.getElementById('itemSalePriceInput').value = bag.salePrice || '';
  costInput.value = bag.cost || '';
  setStockToForm(bag.stock || {});
  stagedImage = null;
  imagePreview.innerHTML = `<img src="${bag.image}" style="max-width:180px;border-radius:8px;">`;
  // Pre-populate stagedExtras from the bag's images[] (skip the lead image which is the main)
  stagedExtras = ((bag.images && bag.images.length > 1) ? bag.images.slice(1) : []).map(url => ({ url }));
  renderExtraImagesPreview();
  document.getElementById('formTitle').textContent = 'Edit item';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  // Hide the IG quick-add panel + "OR enter manually" divider in edit mode —
  // they're irrelevant when editing and they push the populated inputs off-screen
  // on mobile, making it look like the Edit didn't work.
  const igPanel = document.getElementById('igQuickPanel');
  const manualDivider = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = 'none';
  if (manualDivider) manualDivider.style.display = 'none';
  // Scroll the form into view (instant — smooth-scroll over a long page adds a
  // confusing pause). Use the form title element so the "Edit item" h2 is at the top.
  document.getElementById('formTitle').scrollIntoView({ behavior: 'auto', block: 'start' });
}

async function deleteItem(id) {
  if (!await confirmAction('Delete this item? This cannot be undone.', 'Delete')) return;
  let removed = null, removedIdx = -1;
  try {
    await apiMutateAndPublish(() => {
      removedIdx = bags.findIndex(b => b.id === id);
      removed = removedIdx === -1 ? null : bags[removedIdx];
      bags = bags.filter(b => b.id !== id);
    });
    renderList();
    renderDashboard();
    renderInventory();
    showToast('Item deleted.');
  } catch (err) { showToast('Error: ' + err.message); }
}

// ====== RECORD SALE MODAL ======
const saleModal = document.getElementById('saleModal');
const saleSizeInput = document.getElementById('saleSizeInput');
const saleQtyInput = document.getElementById('saleQtyInput');
const salePriceInput = document.getElementById('salePriceInput');
const buyerName = document.getElementById('buyerName');
const buyerPhone = document.getElementById('buyerPhone');
const buyerNotes = document.getElementById('buyerNotes');

function openSaleModal(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  // If 2+ items are multi-selected and this is one of them, she means the batch.
  if (bulkSelected.size >= 2 && bulkSelected.has(id)) { bulkSell(); return; }
  pendingSaleId = id;
  document.getElementById('saleModalTitle').textContent = `Record sale: ${bag.name}`;
  saleSizeInput.innerHTML = '';
  const stock = bag.stock || {};
  const hasSizes = Object.keys(stock).length > 0;
  if (hasSizes) {
    Object.entries(stock).filter(([, q]) => q > 0).forEach(([sz, q]) => {
      const opt = document.createElement('option');
      opt.value = sz;
      opt.textContent = `${sz} (${q} in stock)`;
      saleSizeInput.appendChild(opt);
    });
    if (!saleSizeInput.options.length) {
      showToast('All sizes are out of stock.'); return;
    }
  } else {
    const opt = document.createElement('option'); opt.value = 'One size'; opt.textContent = 'One size'; saleSizeInput.appendChild(opt);
  }
  saleQtyInput.value = 1;
  // Default to the markdown price if the item is on sale, so the recorded sale captures the discount.
  salePriceInput.value = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : bag.price;
  const _sp = document.getElementById('salePaidInput'); if (_sp) _sp.value = '';
  const _sph = document.getElementById('salePaidHint'); if (_sph) _sph.style.display = 'none';
  document.getElementById('salePaidNone')?.classList.remove('active');
  buyerName.value = '';
  buyerPhone.value = '';
  buyerNotes.value = '';
  document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'cash'));
  saleModal.style.display = 'flex';
  buyerName.focus();
}

function closeSaleModal() { saleModal.style.display = 'none'; pendingSaleId = null; }

// withBuyer=false → record the sale and mark sold without capturing any buyer details (no GHL).
async function recordSale(withBuyer) {
  const targetId = pendingSaleId;
  const curBag = bags.find(b => b.id === targetId);
  if (!curBag) return;
  const size = saleSizeInput.value;
  const qty = parseInt(saleQtyInput.value, 10) || 1;
  const salePrice = parseInt(salePriceInput.value, 10) || curBag.price;
  const saleTotalAmt = salePrice * qty;
  let amountPaid = saleTotalAmt;
  if (withBuyer) {
    const paidRaw = (document.getElementById('salePaidInput')?.value || '').trim();
    amountPaid = paidRaw === '' ? saleTotalAmt : Math.min(saleTotalAmt, Math.max(0, parseInt(paidRaw, 10) || 0));
  }
  const payMethod = document.querySelector('#saleModalPay .pos-pay-btn.active')?.dataset.pay || 'cash';
  if (withBuyer && (saleTotalAmt - amountPaid) > 0 && buyerPhone.value.replace(/[^0-9]/g, '').length < 9) {
    if (!await confirmAction("No phone saved for this customer. Without a phone you can't track or collect this balance under their name. Save the sale anyway?", 'Save anyway')) return;
  }
  const sale = {
    size,
    qty,
    salePrice,
    amountPaid,
    paymentMethod: payMethod,
    channel: 'shop',
    buyerName: withBuyer ? buyerName.value.trim() : '',
    buyerPhone: withBuyer ? buyerPhone.value.trim() : '',
    notes: withBuyer ? buyerNotes.value.trim() : '',
    soldAt: new Date().toISOString(),
  };
  closeSaleModal();
  try {
    let soldBag = null;
    await apiMutateAndPublish(() => {
      const bag = bags.find(b => b.id === targetId);
      if (!bag) throw new Error('Item no longer exists — refresh admin');
      // Reduce stock
      if (bag.stock && bag.stock[size] !== undefined) {
        bag.stock[size] = Math.max(0, bag.stock[size] - qty);
      }
      if (!bag.sales) bag.sales = [];
      bag.sales.push(sale);
      soldBag = bag;
    });
    renderList();
    renderDashboard();
    renderInventory();
    showToast(`Sale recorded — ${qty}× ${size} sold.`);
    if (withBuyer && (sale.buyerName || sale.buyerPhone)) sendBuyerToGHL(soldBag, sale);
    // Offer a receipt (same panel the Sell-in-store flow uses).
    lastPosSale = { name: soldBag ? soldBag.name : '', size, qty, amount: salePrice, paid: amountPaid, balance: saleTotalAmt - amountPaid, paymentMethod: sale.paymentMethod, buyerName: sale.buyerName, buyerPhone: sale.buyerPhone, soldAt: sale.soldAt };
    showPosReceipt(lastPosSale);
    document.getElementById('posDash').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { showToast('Error: ' + err.message); }
}

document.getElementById('saleSaveBtn').addEventListener('click', () => recordSale(true));
document.getElementById('saleSkipBtn').addEventListener('click', () => recordSale(false));
document.getElementById('saleCancelBtn').addEventListener('click', closeSaleModal);
document.getElementById('saleModalPay')?.addEventListener('click', e => {
  const b = e.target.closest('.pos-pay-btn'); if (!b) return;
  document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
});

// ====== EDIT / UNDO A RECORDED SALE ======
let editingSale = null; // { bagId, soldAt }

async function undoSale(bagId, soldAt) {
  if (!await confirmAction('Undo this sale? The quantity goes back into stock.', 'Undo sale')) return;
  try {
    await apiMutateAndPublish(() => {
      const bag = bags.find(b => b.id === bagId);
      if (!bag) throw new Error('Item no longer exists — refresh admin');
      const idx = (bag.sales || []).findIndex(x => x.soldAt === soldAt);
      if (idx === -1) throw new Error('Sale not found — refresh admin');
      const s = bag.sales[idx];
      if (bag.stock && bag.stock[s.size] !== undefined) {
        bag.stock[s.size] = (Number(bag.stock[s.size]) || 0) + (Number(s.qty) || 1);
      }
      bag.sales.splice(idx, 1);
    });
    renderList();
    renderDashboard();
    renderInventory();
    showToast('Sale undone, stock restored.');
  } catch (err) { showToast('Error: ' + err.message); }
}

function openEditSale(bagId, soldAt) {
  const bag = bags.find(b => b.id === bagId);
  if (!bag) return;
  const s = (bag.sales || []).find(x => x.soldAt === soldAt);
  if (!s) return;
  editingSale = { bagId, soldAt };
  document.getElementById('editSaleTitle').textContent = `Edit sale: ${bag.name}`;
  document.getElementById('editSaleSize').value = s.size || '';
  document.getElementById('editSaleQty').value = s.qty || 1;
  document.getElementById('editSalePrice').value = (s.salePrice != null ? s.salePrice : bag.price) || 0;
  document.getElementById('editBuyerName').value = s.buyerName || '';
  document.getElementById('editBuyerPhone').value = s.buyerPhone || '';
  document.getElementById('editBuyerNotes').value = s.notes || '';
  document.getElementById('editSaleModal').style.display = 'flex';
}

function closeEditSale() { document.getElementById('editSaleModal').style.display = 'none'; editingSale = null; }

document.getElementById('editSaleSaveBtn').addEventListener('click', async () => {
  if (!editingSale) return;
  const { bagId, soldAt } = editingSale;
  // Read form values now (DOM); apply against the FRESH sale record in the mutator.
  const formSize = document.getElementById('editSaleSize').value.trim();
  const newQty = parseInt(document.getElementById('editSaleQty').value, 10) || 1;
  const formPrice = parseInt(document.getElementById('editSalePrice').value, 10);
  const newBuyerName = document.getElementById('editBuyerName').value.trim();
  const newBuyerPhone = document.getElementById('editBuyerPhone').value.trim();
  const newNotes = document.getElementById('editBuyerNotes').value.trim();
  closeEditSale();
  try {
    await apiMutateAndPublish(() => {
      const bag = bags.find(b => b.id === bagId);
      if (!bag) throw new Error('Item no longer exists — refresh admin');
      const s = (bag.sales || []).find(x => x.soldAt === soldAt);
      if (!s) throw new Error('Sale not found — refresh admin');
      const newSize = formSize || s.size;
      const newPrice = isNaN(formPrice) ? (s.salePrice != null ? s.salePrice : bag.price) : formPrice;
      // Correct stock: put the old quantity back, then take the new quantity out
      if (bag.stock) {
        if (bag.stock[s.size] !== undefined) bag.stock[s.size] = (Number(bag.stock[s.size]) || 0) + (Number(s.qty) || 1);
        if (bag.stock[newSize] !== undefined) bag.stock[newSize] = Math.max(0, (Number(bag.stock[newSize]) || 0) - newQty);
      }
      s.size = newSize;
      s.qty = newQty;
      s.salePrice = newPrice;
      s.buyerName = newBuyerName;
      s.buyerPhone = newBuyerPhone;
      s.notes = newNotes;
    });
    renderList();
    renderDashboard();
    renderInventory();
    showToast('Sale updated.');
  } catch (err) { showToast('Error: ' + err.message); }
});
document.getElementById('editSaleCancelBtn').addEventListener('click', closeEditSale);
saleModal.addEventListener('click', e => { if (e.target === saleModal) closeSaleModal(); });

// ====== RESTOCK MODAL ======
const restockModal = document.getElementById('restockModal');
const restockSizeInput = document.getElementById('restockSizeInput');
const restockQtyInput = document.getElementById('restockQtyInput');

function openRestockModal(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  pendingRestockId = id;
  document.getElementById('restockModalTitle').textContent = `Restock: ${bag.name}`;
  restockSizeInput.innerHTML = '';
  const ALL_SIZES = ['XS','S','M','L','XL','XXL','3XL','28','30','32','34','36','38','40','UK6','UK7','UK8','UK9','UK10','UK11','UK12'];
  ALL_SIZES.forEach(sz => {
    const opt = document.createElement('option'); opt.value = sz;
    const cur = bag.stock?.[sz] || 0;
    opt.textContent = `${sz} (currently ${cur})`;
    restockSizeInput.appendChild(opt);
  });
  restockQtyInput.value = 5;
  restockModal.style.display = 'flex';
}

function closeRestockModal() { restockModal.style.display = 'none'; pendingRestockId = null; }

document.getElementById('restockSaveBtn').addEventListener('click', async () => {
  const targetId = pendingRestockId;
  const size = restockSizeInput.value;
  const qty = parseInt(restockQtyInput.value, 10) || 0;
  if (qty <= 0) { showToast('Enter a quantity to add.'); return; }
  closeRestockModal();
  try {
    await apiMutateAndPublish(() => {
      const bag = bags.find(b => b.id === targetId);
      if (!bag) throw new Error('Item no longer exists — refresh admin');
      if (!bag.stock) bag.stock = {};
      bag.stock[size] = (bag.stock[size] || 0) + qty;
    });
    renderList();
    renderInventory();
    showToast(`+${qty} ${size} added to stock.`);
  } catch (err) { showToast('Error: ' + err.message); }
});

document.getElementById('restockCancelBtn').addEventListener('click', closeRestockModal);
restockModal.addEventListener('click', e => { if (e.target === restockModal) closeRestockModal(); });

// ====== GHL INTEGRATION ======
const GHL_RECAPTCHA_KEY = '6LeDBFwpAAAAAJe8ux9-imrqZ2ueRsEtdiWoDDpX';
async function getCaptchaToken() {
  if (!window.grecaptcha?.enterprise) return '';
  return new Promise(resolve => {
    grecaptcha.enterprise.ready(async () => {
      try { resolve(await grecaptcha.enterprise.execute(GHL_RECAPTCHA_KEY, { action: 'submit' })); }
      catch (e) { resolve(''); }
    });
  });
}
async function sendBuyerToGHL(bag, sale) {
  try {
    const captchaV3 = await getCaptchaToken();
    await fetch(`${API_BASE}/api/buyer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sale.buyerName, phone: sale.buyerPhone,
        notes: sale.notes,
        bag_name: `${bag.name} (${sale.size})`,
        bag_price: sale.salePrice || bag.price,
        captchaV3,
      }),
    });
  } catch (err) { console.warn('GHL submit failed:', err); }
}

// ====== DASHBOARD ======
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }
function relTime(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  const days = Math.floor(sec/86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Best-effort "added to the website" timestamp: explicit createdAt, else the IG
// post date (takenAt; epoch-seconds or ISO), else the millis baked into a manual
// id (item_<ms>). Returns an ISO string, or null if nothing usable.
function itemAddedAt(bag) {
  if (bag.createdAt) return bag.createdAt;
  if (bag.takenAt != null) {
    const t = bag.takenAt;
    if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t).toISOString();
    return t;
  }
  const m = String(bag.id || '').match(/_(\d{10,})/);
  return m ? new Date(parseInt(m[1], 10)).toISOString() : null;
}

function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }

function renderDashboard() {
  const now = new Date();
  const buckets = [
    { label: 'Today',      since: startOfDay(now) },
    { label: 'This week',  since: startOfWeek(now) },
    { label: 'This month', since: startOfMonth(now) },
    { label: 'All time',   since: null },
  ].map(b => {
    let count = 0, revenue = 0;
    bags.forEach(bag => {
      (bag.sales || []).forEach(s => {
        if (!b.since || new Date(s.soldAt) >= b.since) {
          count += Number(s.qty) || 1;
          revenue += (Number(s.salePrice || bag.price)) * (Number(s.qty) || 1);
        }
      });
    });
    return { ...b, count, revenue };
  });

  // All-time profit (admin-only) — sums realised − cost over ONLY the sold items
  // that have a buying price recorded. costKnown = how many of the sold items
  // carry a cost; soldItemsCount = all items with at least one sale (for the
  // coverage note, so a partial figure isn't mistaken for total profit).
  let profitAll = 0, costKnown = 0, soldItemsCount = 0;
  bags.forEach(bag => {
    const sold = totalUnitsSold(bag);
    if (sold <= 0) return;
    soldItemsCount++;
    if (bag.cost) {
      profitAll += totalRevenue(bag) - bag.cost * sold;
      costKnown++;
    }
  });

  document.getElementById('kpiGrid').innerHTML = buckets.map(b => {
    let profitSub = '';
    if (b.label === 'All time' && costKnown > 0) {
      const note = costKnown < soldItemsCount
        ? `<span id="statAllProfitNote" style="color:#999;font-weight:400;"> · from ${costKnown}/${soldItemsCount} with cost</span>`
        : '';
      profitSub = `<div id="statAllProfitSub" class="kpi-profit" style="font-size:12px;color:#2e7d32;font-weight:600;margin-top:2px;">Profit <span id="statAllProfit">${fmtKsh(profitAll)}</span>${note}</div>`;
    }
    return `
    <div class="kpi-card">
      <div class="kpi-label">${b.label}</div>
      <div class="kpi-count">${b.count} <span class="kpi-unit">units</span></div>
      <div class="kpi-revenue">${fmtKsh(b.revenue)}</div>${profitSub}
    </div>`;
  }).join('');

  // POS "today" split — Cash vs M-Pesa takings + sales count (sales lacking
  // paymentMethod, e.g. older/online ones, fall into the Cash bucket).
  const splitEl = document.getElementById('posTodaySplit');
  if (splitEl) {
    const todayStart = startOfDay(now);
    let cashT = 0, mpesaT = 0, soldToday = 0;
    bags.forEach(bag => (bag.sales || []).forEach(s => {
      if (new Date(s.soldAt) >= todayStart) {
        const amt = (Number(s.salePrice || bag.price)) * (Number(s.qty) || 1);
        soldToday += Number(s.qty) || 1;
        if (s.paymentMethod === 'mpesa') mpesaT += amt; else cashT += amt;
      }
    }));
    splitEl.innerHTML = `<span class="pos-today-label">Today's takings</span>`
      + `<span class="pos-chip cash">💵 Cash ${fmtKsh(cashT)}</span>`
      + `<span class="pos-chip mpesa">📱 M-Pesa ${fmtKsh(mpesaT)}</span>`
      + `<span class="pos-chip total">${soldToday} sold</span>`;
  }

  // Top categories by units sold
  const catUnits = {}, catRev = {};
  bags.forEach(bag => {
    const cat = bag.category || 'Other';
    (bag.sales || []).forEach(s => {
      catUnits[cat] = (catUnits[cat] || 0) + (Number(s.qty) || 1);
      catRev[cat] = (catRev[cat] || 0) + (Number(s.salePrice || bag.price)) * (Number(s.qty) || 1);
    });
  });
  const cats = Object.entries(catUnits).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxU = cats[0]?.[1] || 1;
  document.getElementById('topCats').innerHTML = cats.length
    ? cats.map(([cat, n]) => `
        <div class="cat-bar">
          <div class="cat-bar-row"><span class="cat-bar-name">${escapeHtml(cat)}</span><span class="cat-bar-meta">${n} sold · ${fmtKsh(catRev[cat])}</span></div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(n/maxU)*100}%"></div></div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales yet — record your first sale to populate.</p>';

  // Recent sales (all bags, last 6 individual sale records)
  const allSaleRecords = [];
  bags.forEach(bag => (bag.sales || []).forEach(s => allSaleRecords.push({ bag, s })));
  const recent = allSaleRecords.sort((a, b) => new Date(b.s.soldAt) - new Date(a.s.soldAt)).slice(0, 20);
  document.getElementById('recentSales').innerHTML = recent.length
    ? recent.map(({ bag, s }) => `
        <div class="recent-row">
          <div class="recent-main">
            <img src="${bag.image}" alt="${escapeHtml(bag.name)}">
            <div>
              <div class="recent-name">${escapeHtml(bag.name)} · ${escapeHtml(s.size || '')} × ${s.qty || 1}</div>
              <div class="recent-meta">${fmtKsh(s.salePrice || bag.price)} · ${s.buyerName ? escapeHtml(s.buyerName) : 'No buyer saved'} · ${relTime(s.soldAt)}</div>
            </div>
          </div>
          <div class="recent-actions">
            <button onclick="openEditSale('${bag.id}','${s.soldAt}')">Edit</button>
            <button class="danger" onclick="undoSale('${bag.id}','${s.soldAt}')">Undo</button>
          </div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales recorded yet.</p>';
}

// ====== INVENTORY ======
// State for the inventory table view
let invFilter = 'attention'; // 'attention' | 'all'
let invShowAll = false;       // false = cap at INV_PAGE_SIZE
const INV_PAGE_SIZE = 15;

function renderInventory() {
  let totalItems = bags.length;
  let totalUnits = 0, totalValue = 0, lowStock = 0, outOfStock = 0;

  bags.forEach(bag => {
    const units = totalStock(bag);
    totalUnits += units;
    totalValue += units * (bag.price || 0);
    if (units === 0) outOfStock++;
    else if (units <= 5) lowStock++;
  });

  document.getElementById('invKpiGrid').innerHTML = [
    { label: 'Total items', val: totalItems, sub: 'SKUs listed', cls: '' },
    { label: 'Units in stock', val: totalUnits.toLocaleString(), sub: 'across all sizes', cls: 'success' },
    { label: 'Inventory value', val: fmtKsh(totalValue), sub: 'at listed prices', cls: '' },
    { label: 'Low stock', val: lowStock, sub: '≤ 5 units remaining', cls: lowStock > 0 ? 'warn' : '' },
    { label: 'Out of stock', val: outOfStock, sub: 'need restocking', cls: outOfStock > 0 ? 'danger' : '' },
  ].map(k => `
    <div class="inv-kpi ${k.cls}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${k.val}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  // Build the filter bar
  const attentionBags = bags.filter(b => totalStock(b) <= 5);
  const filterBar = document.getElementById('invFilterBar');
  if (filterBar) {
    filterBar.innerHTML = `
      <button class="pill ${invFilter==='attention'?'active':''}" data-inv-filter="attention">
        Needs attention <span class="admin-nav-count">${attentionBags.length}</span>
      </button>
      <button class="pill ${invFilter==='all'?'active':''}" data-inv-filter="all">
        All items <span class="admin-nav-count">${bags.length}</span>
      </button>
    `;
    filterBar.querySelectorAll('[data-inv-filter]').forEach(b => {
      b.addEventListener('click', () => {
        invFilter = b.dataset.invFilter;
        invShowAll = false;
        renderInventory();
      });
    });
  }

  // Apply filter, sort by lowest stock first
  const filtered = (invFilter === 'attention' ? attentionBags : bags)
    .slice()
    .sort((a, b) => totalStock(a) - totalStock(b));

  // Cap rendering unless showAll is set
  const cap = invShowAll ? filtered.length : Math.min(INV_PAGE_SIZE, filtered.length);
  const sorted = filtered.slice(0, cap);

  // Update sort/count label
  const lbl = document.getElementById('invSortLabel');
  if (lbl) lbl.textContent = `showing ${sorted.length} of ${filtered.length} · sorted low → high`;

  document.getElementById('invTableBody').innerHTML = sorted.map(bag => {
    const units = totalStock(bag);
    const soldUnits = totalUnitsSold(bag);
    const stockEntries = Object.entries(bag.stock || {});
    const stockCells = stockEntries.length
      ? stockEntries.map(([sz, q]) => {
          const cls = q === 0 ? 'zero' : q <= 3 ? 'low' : 'ok';
          return `<span class="stock-cell ${cls}">${escapeHtml(sz)}: ${q}</span>`;
        }).join('')
      : '<span style="color:#999;font-size:12px;">No sizes set</span>';

    const statusCls = units === 0 ? 'zero' : units <= 5 ? 'low' : 'ok';
    const statusLabel = units === 0 ? 'Out of stock' : units <= 5 ? 'Low stock' : 'In stock';

    // Admin-only cost/profit subline — shown only when a buying price is recorded.
    let costLine = '';
    if (bag.cost) {
      if (soldUnits > 0) {
        const profit = totalRevenue(bag) - bag.cost * soldUnits;
        costLine = `<div style="font-size:11px;color:#2e7d32;">cost ${fmtKsh(bag.cost)} · profit ${fmtKsh(profit)}</div>`;
      } else {
        const effectivePrice = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : bag.price;
        const margin = effectivePrice - bag.cost;
        costLine = `<div style="font-size:11px;color:#2e7d32;">cost ${fmtKsh(bag.cost)} · margin ${fmtKsh(margin)}</div>`;
      }
    }

    return `
    <tr>
      <td><img class="item-img" src="${bag.image}" alt="${escapeHtml(bag.name)}"></td>
      <td>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(bag.name)}</div>
        <div style="font-size:11px;color:#999;margin-top:2px;">${soldUnits} sold · ${fmtKsh(totalRevenue(bag))} revenue</div>
      </td>
      <td style="font-size:13px;">${escapeHtml(bag.category || '—')}</td>
      <td style="font-size:13px;font-weight:600;">${fmtKsh(bag.price)}${costLine}</td>
      <td><div class="stock-cells">${stockCells}</div></td>
      <td style="font-weight:700;font-size:14px;">${units}</td>
      <td><span class="stock-pill ${statusCls}">${statusLabel}</span></td>
      <td>
        <button class="restock-btn" onclick="openRestockModal('${bag.id}')">+ Restock</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-faint);">${invFilter === 'attention' ? '🎉 Nothing needs attention — all items have healthy stock.' : 'No items yet.'}</td></tr>`;

  // Show-more toggle
  const toggle = document.getElementById('invShowMore');
  if (toggle) {
    if (filtered.length <= INV_PAGE_SIZE) {
      toggle.style.display = 'none';
    } else {
      toggle.style.display = 'block';
      toggle.textContent = invShowAll
        ? `Show fewer (top ${INV_PAGE_SIZE})`
        : `Show all ${filtered.length} items ↓`;
      toggle.onclick = () => { invShowAll = !invShowAll; renderInventory(); };
    }
  }
}

// ====== ITEM LIST ======
let bulkSelected = new Set();

let adminItemSearch = '';
function renderList() {
  syncCustomCategories();
  const list = document.getElementById('adminList');
  document.getElementById('bagCount').textContent = bags.length;
  const navCount = document.getElementById('navItemCount');
  if (navCount) navCount.textContent = bags.length;
  renderBulkBar();
  // Filter by search query — name + category match (case-insensitive)
  const q = adminItemSearch.trim().toLowerCase();
  const filtered = q
    ? bags.filter(b => `${b.name} ${b.category || ''}`.toLowerCase().includes(q))
    : bags;
  // Update search count line
  const countEl = document.getElementById('adminItemSearchCount');
  if (countEl) countEl.textContent = q ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : '';
  list.innerHTML = filtered.map(bag => {
    const units = totalStock(bag);
    const sold = totalUnitsSold(bag);
    const stockSummary = Object.entries(bag.stock || {}).map(([sz, q]) => `${sz}:${q}`).join(' · ') || 'No stock set';
    const checked = bulkSelected.has(bag.id);
    const addedIso = itemAddedAt(bag);
    return `
    <div class="admin-card ${checked ? 'bulk-selected' : ''}">
      <label class="bulk-check" title="Select for bulk actions">
        <input type="checkbox" data-bulk="${escapeHtml(bag.id)}" ${checked ? 'checked' : ''}>
      </label>
      <img src="${bag.image}" alt="${escapeHtml(bag.name)}">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(bag.name)}</div>
        ${bag.category ? `<div class="admin-card-cat-row" style="margin:3px 0;"><span style="background:#f0ede8;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;">${escapeHtml(bag.category)}</span></div>` : ''}
        <div class="admin-card-price">${
          (bag.salePrice > 0 && bag.salePrice < bag.price)
            ? `<s style="color:#999;font-weight:400;">${fmtKsh(bag.price)}</s> <span style="color:#c0392b;font-weight:700;">${fmtKsh(bag.salePrice)}</span> <span style="color:#c0392b;font-weight:700;">· SALE</span>`
            : fmtKsh(bag.price)
        }<span class="admin-card-mobile-stock"> · ${units} in stock</span></div>
        <div class="admin-card-stock">${units} in stock · ${sold} sold | ${stockSummary}</div>
        ${addedIso ? `<div class="admin-card-added" title="Added ${new Date(addedIso).toLocaleString('en-KE')}">Added ${relTime(addedIso)}</div>` : ''}
        <div class="admin-card-actions">
          <button onclick="editItem('${bag.id}')">Edit</button>
          <button onclick="openSaleModal('${bag.id}')" style="background:#f0faf4;border-color:#b0d8c0;color:#1a7a40;">Sell</button>
          <button onclick="openRestockModal('${bag.id}')">Restock</button>
          <button class="danger" onclick="deleteItem('${bag.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Wire up the new checkboxes
  list.querySelectorAll('input[data-bulk]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) bulkSelected.add(cb.dataset.bulk);
      else bulkSelected.delete(cb.dataset.bulk);
      cb.closest('.admin-card').classList.toggle('bulk-selected', cb.checked);
      renderBulkBar();
    });
  });
}

function renderBulkBar() {
  const bar = document.getElementById('bulkActions');
  if (!bar) return;
  if (bulkSelected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('bulkCount').textContent = bulkSelected.size;
}

function bulkClear() { bulkSelected.clear(); renderList(); }

function bulkSelectAll() {
  bags.forEach(b => bulkSelected.add(b.id));
  renderList();
}

async function bulkDelete() {
  if (!await confirmAction(`Delete ${bulkSelected.size} item(s)? This cannot be undone.`, 'Delete')) return;
  const ids = new Set(bulkSelected);
  bulkSelected.clear();
  let removed = [];
  try {
    await apiMutateAndPublish(() => {
      removed = [];
      bags.forEach((b, i) => { if (ids.has(b.id)) removed.push({ item: b, index: i }); });
      bags = bags.filter(b => !ids.has(b.id));
    });
    renderList();
    renderInventory();
    renderDashboard();
    showToast('Deleted.');
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}

async function bulkSetCategory() {
  const cat = await chooseCategory();
  if (!cat) return;
  const ids = new Set(bulkSelected);
  const n = ids.size;
  try {
    await apiMutateAndPublish(() => {
      bags.forEach(b => { if (ids.has(b.id)) b.category = cat; });
    });
    bulkSelected.clear();
    renderList();
    renderInventory();
    showToast(`Set ${n} item(s) to "${cat}".`);
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}

// ====== BULK SELL TO ONE CUSTOMER (new-stock: each selected item → its own sale, qty 1) ======
// Sells every selected in-stock item to the same buyer in one go. Per item the
// owner picks a model only when the item has more than one in-stock model; qty is
// 1 each (a multi-item bundle). An optional part-payment for the whole lot is
// allocated across items oldest-first so the Owed ledger works. Buyer details
// (and the existing-customer picker) are entered once.
function bsEffPrice(b) { return (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0); }
function bsInStockSizes(b) {
  const stock = b.stock || {};
  const keys = Object.keys(stock);
  if (!keys.length) return ['One size'];
  return keys.filter(k => Number(stock[k]) > 0);
}
function bulkSellableSelected() { return bags.filter(b => bulkSelected.has(b.id) && bsInStockSizes(b).length > 0); }
let bulkSellTotalAmt = 0;
window.bulkSell = () => {
  const list = bulkSellableSelected();
  if (!list.length) { showToast('Select at least one in-stock item to sell.'); return; }
  bulkSellTotalAmt = list.reduce((s, b) => s + bsEffPrice(b), 0);
  document.getElementById('bulkSellTitle').textContent = `Sell ${list.length} item${list.length === 1 ? '' : 's'} to one customer`;
  document.getElementById('bulkSellRows').innerHTML = list.map(b => {
    const sizes = bsInStockSizes(b);
    const ctl = sizes.length > 1
      ? `<select class="bsr-size" data-id="${b.id}">${sizes.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>`
      : `<span class="bsr-onesize" data-id="${b.id}" data-size="${escapeHtml(sizes[0])}">${escapeHtml(sizes[0])}</span>`;
    return `<div class="bulksell-row"><span class="bulksell-row-name">${escapeHtml(b.name)} · ${fmtKsh(bsEffPrice(b))}</span>${ctl}</div>`;
  }).join('');
  document.getElementById('bulkSellTotal').textContent = `Total: ${fmtKsh(bulkSellTotalAmt)} · ${list.length} item${list.length === 1 ? '' : 's'}`;
  ['bulkSellName', 'bulkSellPhone', 'bulkSellNotes', 'bulkSellPaid', 'bulkSellCustSearch'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('bulkSellPaid').placeholder = 'Paid in full';
  document.getElementById('bulkSellPaidHint').style.display = 'none';
  document.getElementById('bulkSellPaidNone').classList.remove('active');
  const cr = document.getElementById('bulkSellCustResults'); if (cr) { cr.style.display = 'none'; cr.innerHTML = ''; }
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'cash'));
  document.getElementById('bulkSellModal').style.display = 'flex';
};
function closeBulkSell() { document.getElementById('bulkSellModal').style.display = 'none'; }
function updateBulkSellHint() {
  const raw = (document.getElementById('bulkSellPaid').value || '').trim();
  document.getElementById('bulkSellPaidNone').classList.toggle('active', raw === '0');
  const hint = document.getElementById('bulkSellPaidHint');
  if (raw === '') { hint.style.display = 'none'; return; }
  const bal = bulkSellTotalAmt - Math.min(bulkSellTotalAmt, Math.max(0, parseInt(raw, 10) || 0));
  hint.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hint.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
async function commitBulkSold(withBuyer) {
  const initial = bulkSellableSelected();
  if (!initial.length) { closeBulkSell(); return; }
  // Read the chosen model per item from the DOM before we close the modal.
  const chosen = initial.map(b => {
    const sel = document.querySelector(`.bsr-size[data-id="${b.id}"]`);
    const one = document.querySelector(`.bsr-onesize[data-id="${b.id}"]`);
    return { id: b.id, size: sel ? sel.value : (one ? one.dataset.size : 'One size'), price: bsEffPrice(b) };
  });
  const payMethod = document.querySelector('#bulkSellPay .pos-pay-btn.active')?.dataset.pay || 'cash';
  const buyer = { name: '', phone: '', notes: '' };
  if (withBuyer) {
    buyer.name = document.getElementById('bulkSellName').value.trim();
    buyer.phone = document.getElementById('bulkSellPhone').value.trim().replace(/[^0-9+]/g, '');
    buyer.notes = document.getElementById('bulkSellNotes').value.trim();
    if (!buyer.name && !buyer.phone) { showToast('Add a name or phone, or hit Skip.'); return; }
  }
  const paidRaw = (document.getElementById('bulkSellPaid').value || '').trim();
  const hasPartial = withBuyer && paidRaw !== '';
  closeBulkSell();
  const soldAt = new Date().toISOString();
  let soldList = [];
  try {
    await apiMutateAndPublish(() => {
      let remaining = hasPartial ? Math.max(0, parseInt(paidRaw, 10) || 0) : Infinity;
      soldList = [];
      for (const ch of chosen) {
        const bag = bags.find(b => b.id === ch.id);
        if (!bag) continue;
        const stock = bag.stock || {};
        const hasStockObj = Object.keys(stock).length > 0;
        if (hasStockObj && !(Number(stock[ch.size]) > 0)) continue; // model sold out since the modal opened
        const total = ch.price; // qty 1
        const amountPaid = hasPartial ? Math.min(remaining, total) : total;
        if (hasPartial) remaining = Math.max(0, remaining - amountPaid);
        const sale = {
          size: ch.size, qty: 1, salePrice: ch.price, amountPaid,
          paymentMethod: payMethod, channel: 'shop',
          buyerName: withBuyer ? buyer.name : '', buyerPhone: withBuyer ? buyer.phone : '',
          notes: withBuyer ? buyer.notes : '', soldAt,
        };
        if (hasStockObj && stock[ch.size] !== undefined) stock[ch.size] = Math.max(0, Number(stock[ch.size]) - 1);
        if (!bag.sales) bag.sales = [];
        bag.sales.push(sale);
        soldList.push({ bag, sale });
      }
    });
    bulkSelected.clear();
    renderList(); renderDashboard(); renderInventory();
    if (typeof renderClients === 'function') renderClients();
    if (typeof renderOwed === 'function') renderOwed();
    const total = soldList.reduce((s, x) => s + (Number(x.sale.salePrice) || 0), 0);
    const owed = hasPartial ? Math.max(0, total - Math.max(0, parseInt(paidRaw, 10) || 0)) : 0;
    showToast(`Sold ${soldList.length} item${soldList.length === 1 ? '' : 's'}${withBuyer && buyer.name ? ' to ' + buyer.name : ''} · ${fmtKsh(total)}${owed > 0 ? ` · ${fmtKsh(owed)} owed` : ''}`);
    if (withBuyer && buyer.phone && soldList[0]) sendBuyerToGHL(soldList[0].bag, soldList[0].sale);
  } catch (err) { showToast('Error: ' + err.message); }
}
// Existing-customer picker (shared by future single-modal use too).
function wireCustomerPicker({ searchId, resultsId, nameId, phoneId }) {
  const search = document.getElementById(searchId);
  const box = document.getElementById(resultsId);
  if (!search || !box) return;
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    if (!term) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const digits = term.replace(/[^0-9+]/g, '');
    const matches = clientsLedger()
      .filter(c => (c.name || '').toLowerCase().includes(term) || (digits && (c.phone || '').includes(digits)))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 8);
    box.innerHTML = matches.length
      ? matches.map(c => {
          const meta = `${escapeHtml(c.phone || '')}${c.purchases.length ? ` · ${c.purchases.length} bought` : ''}`;
          return `<button type="button" class="client-item-opt" data-name="${escapeHtml(c.name || '')}" data-phone="${escapeHtml(c.phone || '')}">${escapeHtml(c.name || '(no name)')}<span>${meta}</span></button>`;
        }).join('')
      : '<div class="client-item-empty">No saved customer matches. Type the details below to add a new one.</div>';
    box.style.display = '';
  });
  box.addEventListener('click', e => {
    const opt = e.target.closest('.client-item-opt');
    if (!opt) return;
    document.getElementById(nameId).value = opt.dataset.name || '';
    document.getElementById(phoneId).value = opt.dataset.phone || '';
    search.value = opt.dataset.name || opt.dataset.phone || '';
    box.style.display = 'none';
    showToast('Customer selected — edit if needed.');
  });
}
wireCustomerPicker({ searchId: 'bulkSellCustSearch', resultsId: 'bulkSellCustResults', nameId: 'bulkSellName', phoneId: 'bulkSellPhone' });
document.getElementById('bulkSellSaveBtn')?.addEventListener('click', () => commitBulkSold(true));
document.getElementById('bulkSellSkipBtn')?.addEventListener('click', () => commitBulkSold(false));
document.getElementById('bulkSellCancelBtn')?.addEventListener('click', closeBulkSell);
document.getElementById('bulkSellModal')?.addEventListener('click', e => { if (e.target.id === 'bulkSellModal') closeBulkSell(); });
document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b === btn));
}));
document.getElementById('bulkSellPaid')?.addEventListener('input', updateBulkSellHint);
document.getElementById('bulkSellPaidNone')?.addEventListener('click', () => {
  document.getElementById('bulkSellPaid').value = '0';
  updateBulkSellHint();
});

// ====== BULK SALE / MARKDOWN ======
function roundTo50(n) { return Math.max(50, Math.round(n / 50) * 50); }

window.bulkPutOnSale = () => {
  if (!bulkSelected.size) return;
  document.getElementById('bulkSaleCount').textContent = bulkSelected.size;
  document.getElementById('bulkSalePct').value = '';
  document.getElementById('bulkSaleFixed').value = '';
  setSaleMode('pct');
  document.getElementById('bulkSaleModal').style.display = 'flex';
};

function setSaleMode(mode) {
  document.querySelectorAll('.sale-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.saleMode === mode));
  document.getElementById('bulkSalePctField').style.display = mode === 'pct' ? '' : 'none';
  document.getElementById('bulkSaleFixedField').style.display = mode === 'fixed' ? '' : 'none';
}
document.querySelectorAll('.sale-mode-btn').forEach(btn => btn.addEventListener('click', () => setSaleMode(btn.dataset.saleMode)));
document.getElementById('bulkSaleCancelBtn')?.addEventListener('click', () => { document.getElementById('bulkSaleModal').style.display = 'none'; });
document.getElementById('bulkSaleSaveBtn')?.addEventListener('click', async () => {
  const mode = document.querySelector('.sale-mode-btn.active')?.dataset.saleMode || 'pct';
  const ids = new Set(bulkSelected);
  let pct = null, fixed = null;
  if (mode === 'pct') {
    pct = parseInt(document.getElementById('bulkSalePct').value, 10);
    if (!pct || pct < 1 || pct > 90) { showToast('Enter a percent between 1 and 90.'); return; }
  } else {
    fixed = parseInt(document.getElementById('bulkSaleFixed').value, 10);
    if (!fixed || fixed <= 0) { showToast('Enter a valid sale price.'); return; }
  }
  document.getElementById('bulkSaleModal').style.display = 'none';
  let applied = 0, skipped = 0;
  try {
    await apiMutateAndPublish(() => {
      applied = 0; skipped = 0;
      bags.forEach(b => {
        if (!ids.has(b.id) || !(b.price > 0)) return; // can't discount "price on request"
        const sp = mode === 'pct' ? roundTo50(Number(b.price) * (1 - pct / 100)) : fixed;
        if (sp < Number(b.price)) { b.salePrice = sp; applied++; } else { skipped++; }
      });
      if (!applied) throw new Error('No items updated, sale price was not below their price.');
    });
    bulkSelected.clear();
    renderList(); renderInventory(); renderDashboard();
    showToast(`On sale: ${applied} item${applied === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}.`);
  } catch (err) { showToast(err.message.startsWith('No items') ? err.message : 'Sync failed: ' + err.message); }
});

window.bulkRemoveSale = async () => {
  if (!bulkSelected.size) return;
  const ids = new Set(bulkSelected);
  let n = 0;
  try {
    await apiMutateAndPublish(() => {
      n = 0;
      bags.forEach(b => { if (ids.has(b.id) && b.salePrice != null) { delete b.salePrice; n++; } });
      if (!n) throw new Error('None of the selected items were on sale.');
    });
    bulkSelected.clear();
    renderList(); renderInventory(); renderDashboard();
    showToast(`Removed sale from ${n} item${n === 1 ? '' : 's'}.`);
  } catch (err) { showToast(err.message.startsWith('None of') ? err.message : 'Sync failed: ' + err.message); }
};



// ====== INIT ======
window.editItem = editItem;
window.deleteItem = deleteItem;
window.openSaleModal = openSaleModal;
window.openRestockModal = openRestockModal;
window.bulkClear = bulkClear;
window.bulkSelectAll = bulkSelectAll;
window.bulkDelete = bulkDelete;
window.bulkSetCategory = bulkSetCategory;
window.undoSale = undoSale;
window.openEditSale = openEditSale;

// ====== CLIENTS (free CRM roster) ======
// Who has bought, with what they bought, total spend, and one-tap WhatsApp.
// New-stock model: buyers live in each bag's sales[] (deduped by phone).
let clientsQuery = '';
let clientsSort = 'recent';
function clientsLedger() {
  const map = new Map();
  for (const bag of bags) {
    for (const s of (bag.sales || [])) {
      if (!s || !s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const at = new Date(s.soldAt || 0).getTime();
      const amount = Number(s.salePrice || bag.price || 0) * (Number(s.qty) || 1);
      let c = map.get(phone);
      if (!c) { c = { phone, name: '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
      c.purchases.push({ bagName: bag.name, size: s.size || '', qty: Number(s.qty) || 1, amount, at: s.soldAt });
      c.spend += amount;
      if (at >= c.lastAt) { c.lastAt = at; if (s.buyerName) c.name = s.buyerName; }
      else if (!c.name && s.buyerName) c.name = s.buyerName;
    }
  }
  // Overlay manually-added clients (may have zero purchases yet).
  for (const mc of (clients || [])) {
    if (!mc || !mc.phone) continue;
    const phone = String(mc.phone).replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    let c = map.get(phone);
    if (!c) { c = { phone, name: '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
    c.manualId = mc.id;
    if (mc.note) c.note = mc.note;
    if (!c.name && mc.name) c.name = mc.name;
    if (mc.createdAt) c.addedAt = mc.createdAt;
  }
  return [...map.values()];
}
// Normalise a Kenyan number to wa.me international form (254…, no +).
function clientWaPhone(p) {
  let d = String(p).replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (d.length === 9) d = '254' + d;
  return d;
}
function renderClients() {
  const listEl = document.getElementById('clientsList');
  if (!listEl) return;
  const ledger = clientsLedger();
  const totalSpend = ledger.reduce((s, c) => s + c.spend, 0);
  const repeat = ledger.filter(c => c.purchases.length >= 2).length;
  const avg = ledger.length ? Math.round(totalSpend / ledger.length) : 0;

  const nav = document.getElementById('navClientsCount'); if (nav) nav.textContent = ledger.length || '';

  const kpi = document.getElementById('clientsKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Clients</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${repeat} repeat buyer${repeat === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi success"><div class="inv-kpi-label">Total spent</div><div class="inv-kpi-val">${fmtKsh(totalSpend)}</div><div class="inv-kpi-sub">across all clients</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Avg per client</div><div class="inv-kpi-val">${fmtKsh(avg)}</div><div class="inv-kpi-sub">lifetime value</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Repeat rate</div><div class="inv-kpi-val">${ledger.length ? Math.round(repeat / ledger.length * 100) : 0}%</div><div class="inv-kpi-sub">bought 2+ times</div></div>
  `;

  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients yet. When you record a sale and save the buyer\'s name and phone, they show up here so you can message them again.</p>';
    return;
  }
  const q = clientsQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) =>
      clientsSort === 'spend' ? b.spend - a.spend :
      clientsSort === 'purchases' ? b.purchases.length - a.purchases.length :
      b.lastAt - a.lastAt);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const items = c.purchases.slice()
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(p => `<span class="client-item">${escapeHtml(p.bagName)}${p.size ? ' · ' + escapeHtml(p.size) : ''} × ${p.qty} · ${fmtKsh(p.amount)}</span>`).join('');
    const has = c.purchases.length;
    const when = has ? `last ${relTime(new Date(c.lastAt).toISOString())}`
                     : (c.addedAt ? `added ${relTime(c.addedAt)}` : 'no purchases yet');
    const manualTag = c.manualId ? '<span class="client-tag">Added manually</span>' : '';
    const noteLine = c.note ? `<div class="client-note">${escapeHtml(c.note)}</div>` : '';
    // Remove only for a manual contact with NO purchases (added by mistake). A
    // client who has bought is real sales history — no one-tap remove.
    const removeBtn = (c.manualId && !has) ? `<button class="btn-admin danger" onclick="removeClient('${c.manualId}')">Remove</button>` : '';
    return `
      <div class="client-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(c.name || 'Unnamed buyer')}${manualTag}</div>
          <div class="client-row-sub">${escapeHtml(c.phone)} · ${has} purchase${has === 1 ? '' : 's'} · ${fmtKsh(c.spend)} spent · ${when}</div>
          ${noteLine}
          <div class="client-items">${items}</div>
        </div>
        <div class="client-row-actions">
          <button class="btn-admin gold" onclick="clientMessage('${c.phone}')">WhatsApp</button>
          ${removeBtn}
        </div>
      </div>`;
  }).join('');
}
window.clientMessage = phone => {
  const c = clientsLedger().find(x => x.phone === phone);
  const first = (c && c.name ? c.name : 'there').split(' ')[0];
  const msg = `Hi ${first}! Thanks for shopping with Phone Guard Store. Fresh pieces just landed. Want me to send you what's new?`;
  window.open(`https://wa.me/${clientWaPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};
// Manually add / remove a client (server-synced via the clients[] list).
// ----- "Item bought" autocomplete: type → tappable matches → select one -----
let acItemId = ''; // selected item id ('' = none / contact-only)
function acRenderResults(q) {
  const box = document.getElementById('addClientItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = bags.filter(b => (b.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(b => {
        const units = Object.values(b.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);
        const meta = Object.keys(b.stock || {}).length ? `${units} in stock` : fmtKsh(b.price);
        return `<button type="button" class="client-item-opt" data-id="${b.id}">${escapeHtml(b.name)}<span>${meta}</span></button>`;
      }).join('')
    : '<div class="client-item-empty">No items match.</div>';
  box.style.display = '';
}
function acSelectItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  acItemId = id;
  document.getElementById('addClientItemSearch').value = bag.name;
  document.getElementById('addClientItemResults').style.display = 'none';
  const sizeSel = document.getElementById('addClientSize');
  sizeSel.innerHTML = '';
  const inStock = Object.entries(bag.stock || {}).filter(([, q]) => q > 0);
  if (inStock.length) {
    inStock.forEach(([sz, q]) => { const o = document.createElement('option'); o.value = sz; o.textContent = `${sz} (${q} in stock)`; sizeSel.appendChild(o); });
  } else {
    const o = document.createElement('option'); o.value = 'One size'; o.textContent = 'One size'; sizeSel.appendChild(o);
  }
  document.getElementById('addClientQty').value = 1;
  document.getElementById('addClientPrice').value = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : bag.price;
  document.getElementById('addClientChosen').innerHTML = `Recording a sale for <strong>${escapeHtml(bag.name)}</strong> · <button type="button" id="addClientClearItem">clear</button>`;
  document.getElementById('addClientChosen').style.display = '';
  document.getElementById('addClientSaleFields').style.display = '';
}
function acClearItem() {
  acItemId = '';
  document.getElementById('addClientItemSearch').value = '';
  document.getElementById('addClientItemResults').style.display = 'none';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
}
function openAddClient() {
  document.getElementById('addClientName').value = '';
  document.getElementById('addClientPhone').value = '';
  document.getElementById('addClientNote').value = '';
  acClearItem();
  document.getElementById('addClientModal').style.display = 'flex';
  document.getElementById('addClientName').focus();
}
function closeAddClient() { document.getElementById('addClientModal').style.display = 'none'; }
document.getElementById('clientsAddBtn')?.addEventListener('click', openAddClient);
document.getElementById('addClientCancelBtn')?.addEventListener('click', closeAddClient);
document.getElementById('addClientModal')?.addEventListener('click', e => { if (e.target.id === 'addClientModal') closeAddClient(); });
document.getElementById('addClientItemSearch')?.addEventListener('input', e => {
  acItemId = '';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
  acRenderResults(e.target.value.trim());
});
document.getElementById('addClientItemResults')?.addEventListener('click', e => {
  const opt = e.target.closest('.client-item-opt');
  if (opt) acSelectItem(opt.dataset.id);
});
document.getElementById('addClientChosen')?.addEventListener('click', e => {
  if (e.target.id === 'addClientClearItem') acClearItem();
});
document.getElementById('addClientSaveBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('addClientName').value.trim();
  const phone = document.getElementById('addClientPhone').value.trim().replace(/[^0-9+]/g, '');
  const note = document.getElementById('addClientNote').value.trim();
  if (!name) { showToast('Enter a name.'); return; }
  if (phone.replace(/[^0-9]/g, '').length < 9) { showToast('Enter a valid phone number.'); return; }
  const itemId = acItemId;
  let size, qty, salePrice;
  if (itemId) {
    size = document.getElementById('addClientSize').value;
    qty = parseInt(document.getElementById('addClientQty').value, 10) || 1;
    salePrice = parseInt(document.getElementById('addClientPrice').value, 10);
  }
  const btn = document.getElementById('addClientSaveBtn');
  btn.disabled = true;
  try {
    await apiMutateAndPublish(() => {
      if (!Array.isArray(clients)) clients = [];
      const norm = phone.replace(/[^0-9]/g, '');
      const existing = clients.find(c => String(c.phone).replace(/[^0-9]/g, '') === norm);
      if (existing) { existing.name = name; existing.note = note; }
      else clients.push({ id: 'c_' + Date.now(), name, phone, note, createdAt: new Date().toISOString() });
      if (itemId) {
        const bag = bags.find(b => b.id === itemId);
        if (!bag) throw new Error('Item no longer exists — refresh admin');
        if (bag.stock && bag.stock[size] !== undefined) bag.stock[size] = Math.max(0, bag.stock[size] - qty);
        if (!bag.sales) bag.sales = [];
        bag.sales.push({ size, qty, salePrice: salePrice || bag.price, buyerName: name, buyerPhone: phone, notes: note, soldAt: new Date().toISOString() });
      }
    });
    closeAddClient();
    renderClients(); renderDashboard(); renderInventory(); renderList();
    if (typeof renderOwed === 'function') renderOwed();
    showToast(itemId ? 'Client saved + sale recorded.' : 'Client saved.');
  } catch (e) { showToast('Save failed: ' + e.message); }
  finally { btn.disabled = false; }
});
window.removeClient = async (id) => {
  if (!await confirmAction('Remove this client from your list? Their past sales (if any) stay in your records.', 'Remove')) return;
  try {
    await apiMutateAndPublish(() => { clients = (clients || []).filter(c => c.id !== id); });
    renderClients();
    showToast('Client removed.');
  } catch (e) { showToast('Remove failed: ' + e.message); }
};
document.getElementById('clientsSearch')?.addEventListener('input', e => { clientsQuery = e.target.value.trim(); renderClients(); });
document.getElementById('clientsSort')?.addEventListener('change', e => { clientsSort = e.target.value; renderClients(); });
// "NEW" badge on the Clients nav link — kept permanently visible (owner asked
// for it to always show). No auto-dismiss; the badge renders from the HTML/CSS.

// ====== MONEY OWED — customer balances (buying on credit / pay later) ======
// A sale's amountPaid is the cash taken at the time of sale; later part-payments
// are appended to sale.payments[]. Any sale recorded before this feature has no
// amountPaid, so it reads as paid in full — old data is never shown as owing.
function saleTotal(bag, s) { return (Number(s.salePrice != null ? s.salePrice : bag.price) || 0) * (Number(s.qty) || 1); }
function salePaid(bag, s) {
  const total = saleTotal(bag, s);
  const initial = (s.amountPaid != null) ? Math.max(0, Number(s.amountPaid) || 0) : total;
  const extra = (s.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return Math.min(total, initial + extra);
}
function saleBalance(bag, s) { return Math.max(0, saleTotal(bag, s) - salePaid(bag, s)); }

function owedByPhone() {
  const m = {};
  for (const bag of bags) for (const s of (bag.sales || [])) {
    const bal = saleBalance(bag, s);
    if (bal <= 0) continue;
    const phone = String(s.buyerPhone || '').replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    m[phone] = (m[phone] || 0) + bal;
  }
  return m;
}

function owedLedger() {
  const map = new Map();
  for (const bag of bags) {
    for (const s of (bag.sales || [])) {
      const bal = saleBalance(bag, s);
      if (bal <= 0) continue;
      const phone = String(s.buyerPhone || '').replace(/[^0-9]/g, '');
      const hasPhone = phone.length >= 9;
      const key = hasPhone ? phone : '__nophone__';
      let c = map.get(key);
      if (!c) { c = { phone: hasPhone ? phone : '', name: '', owed: 0, lines: [], _lastAt: 0 }; map.set(key, c); }
      c.owed += bal;
      c.lines.push({ bagId: bag.id, soldAt: s.soldAt, bagName: bag.name, size: s.size || '', total: saleTotal(bag, s), balance: bal, at: s.soldAt, notes: s.notes || '' });
      const at = new Date(s.soldAt || 0).getTime();
      if (s.buyerName && at >= c._lastAt) { c.name = s.buyerName; c._lastAt = at; }
      else if (!c.name && s.buyerName) c.name = s.buyerName;
    }
  }
  return [...map.values()];
}

let owedQuery = '';
function renderOwed() {
  const listEl = document.getElementById('owedList');
  if (!listEl) return;
  const ledger = owedLedger();
  const totalOwed = ledger.reduce((s, c) => s + c.owed, 0);
  const withPhone = ledger.filter(c => c.phone);
  let oldest = null;
  ledger.forEach(c => c.lines.forEach(l => { const t = new Date(l.at || 0).getTime(); if (t && (oldest === null || t < oldest)) oldest = t; }));

  const nav = document.getElementById('navOwedCount'); if (nav) nav.textContent = ledger.length || '';
  const navLink = document.getElementById('owedNavLink'); if (navLink) navLink.classList.toggle('admin-nav-owed-on', totalOwed > 0);

  const kpi = document.getElementById('owedKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi danger"><div class="inv-kpi-label">Total owed to you</div><div class="inv-kpi-val">${fmtKsh(totalOwed)}</div><div class="inv-kpi-sub">across ${ledger.length} customer${ledger.length === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Customers owing</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${withPhone.length} with a phone saved</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Oldest balance</div><div class="inv-kpi-val">${oldest ? relTime(new Date(oldest).toISOString()) : '—'}</div><div class="inv-kpi-sub">${oldest ? 'taken ' + fmtDate(new Date(oldest).toISOString()) : 'since the item was taken'}</div></div>
  `;

  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No one owes you right now. When you record a sale and the customer pays less than the full price, the balance shows up here so you can chase it.</p>';
    return;
  }
  const q = owedQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) => b.owed - a.owed);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No customers match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const items = c.lines.slice().sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(l => `<span class="owed-line">${escapeHtml(l.bagName)}${l.size ? ' · ' + escapeHtml(l.size) : ''} · owes ${fmtKsh(l.balance)} of ${fmtKsh(l.total)} · taken ${fmtDate(l.at)} (${relTime(l.at)})${l.notes ? ` · <em>${escapeHtml(l.notes)}</em>` : ''}</span>`).join('');
    const noPhone = !c.phone;
    const title = noPhone ? 'Buyer not saved' : (c.name || 'Unnamed customer');
    const sub = noPhone
      ? `${c.lines.length} item${c.lines.length === 1 ? '' : 's'} on credit · no phone saved`
      : `${escapeHtml(c.phone)} · ${c.lines.length} item${c.lines.length === 1 ? '' : 's'} on credit`;
    const noteLine = noPhone ? '<div class="client-note">Add this customer\'s phone (Edit the sale in Recent sales) so you can track and collect it.</div>' : '';
    const actions = noPhone ? '' : `
          <button class="btn-admin gold" onclick="openPayDebt('${c.phone}')">Record payment</button>
          <button class="btn-admin" onclick="remindDebt('${c.phone}')">Remind</button>`;
    return `
      <div class="client-row owed-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(title)} <span class="owed-amount">owes ${fmtKsh(c.owed)}</span></div>
          <div class="client-row-sub">${sub}</div>
          ${noteLine}
          <div class="owed-lines">${items}</div>
          <div class="owed-total">Total owing: <span class="owed-amount">${fmtKsh(c.owed)}</span></div>
        </div>
        <div class="client-row-actions">${actions}</div>
      </div>`;
  }).join('');
}
document.getElementById('owedSearch')?.addEventListener('input', e => { owedQuery = e.target.value.trim(); renderOwed(); });

// ----- Record a payment against a customer's balance (oldest debt first) -----
let payingPhone = '';
function openPayDebt(phone) {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  payingPhone = phone;
  document.getElementById('payDebtName').textContent = c.name || c.phone;
  document.getElementById('payDebtOwed').textContent = fmtKsh(c.owed);
  document.getElementById('payDebtAmount').value = c.owed;
  document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  document.getElementById('payDebtModal').style.display = 'flex';
  document.getElementById('payDebtAmount').focus();
}
window.openPayDebt = openPayDebt;
function closePayDebt() { document.getElementById('payDebtModal').style.display = 'none'; payingPhone = ''; }
document.getElementById('payDebtCancelBtn')?.addEventListener('click', closePayDebt);
document.getElementById('payDebtModal')?.addEventListener('click', e => { if (e.target.id === 'payDebtModal') closePayDebt(); });
document.getElementById('payDebtPay')?.addEventListener('click', e => { const b = e.target.closest('.pos-pay-btn'); if (!b) return; document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b)); });
document.getElementById('payDebtSaveBtn')?.addEventListener('click', async () => {
  const phone = payingPhone;
  const amount = parseInt(document.getElementById('payDebtAmount').value, 10);
  const method = document.querySelector('#payDebtPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  if (!phone) return;
  if (isNaN(amount) || amount <= 0) { showToast('Enter how much they paid.'); return; }
  closePayDebt();
  const at = new Date().toISOString();
  try {
    let applied = 0;
    await apiMutateAndPublish(() => {
      const lines = [];
      for (const bag of bags) for (const s of (bag.sales || [])) {
        if (String(s.buyerPhone || '').replace(/[^0-9]/g, '') !== phone) continue;
        if (saleBalance(bag, s) > 0) lines.push({ bag, s });
      }
      lines.sort((a, b) => new Date(a.s.soldAt || 0) - new Date(b.s.soldAt || 0));
      let remaining = amount;
      for (const { bag, s } of lines) {
        if (remaining <= 0) break;
        const pay = Math.min(saleBalance(bag, s), remaining);
        if (pay <= 0) continue;
        if (!s.payments) s.payments = [];
        s.payments.push({ amount: pay, at, method });
        remaining -= pay; applied += pay;
      }
    });
    renderOwed(); renderClients(); renderDashboard();
    showToast(applied > 0 ? `Payment of ${fmtKsh(applied)} recorded.` : 'That balance is already cleared.');
  } catch (e) { showToast('Error: ' + e.message); }
});
window.remindDebt = phone => {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  const first = (c.name || 'there').split(' ')[0];
  const n = c.lines.length;
  const list = c.lines.map((l, i) => `${i + 1}. *${l.bagName}*${l.size ? ' (' + l.size + ')' : ''}\n    Taken ${fmtDate(l.at)} · balance ${fmtKsh(l.balance)}`).join('\n');
  const intro = n === 1
    ? `A friendly reminder about your balance on the item you took from Phone Guard Store:`
    : `A friendly reminder about the ${n} items you took from Phone Guard Store that still have a balance:`;
  const msg = `Hi ${first}, hope you're doing well.\n\n${intro}\n\n${list}\n\n*Total still owing: ${fmtKsh(c.owed)}*\nYou can pay via M-Pesa whenever you're ready. Thank you!`;
  window.open(`https://wa.me/${clientWaPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};

// Live "balance owing" hint + "Not paid yet" pill sync, on both sale paths.
function paidHint(priceEl, qtyEl, paidEl, hintEl) {
  const total = (parseInt(priceEl.value, 10) || 0) * (parseInt(qtyEl.value, 10) || 1);
  const raw = (paidEl.value || '').trim();
  if (raw === '') { hintEl.style.display = 'none'; return; }
  const bal = total - Math.min(total, Math.max(0, parseInt(raw, 10) || 0));
  hintEl.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hintEl.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
function syncPaid(priceId, qtyId, paidId, hintId, btnId) {
  const paidEl = document.getElementById(paidId);
  paidHint(document.getElementById(priceId), document.getElementById(qtyId), paidEl, document.getElementById(hintId));
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.toggle('active', (paidEl.value || '').trim() === '0');
}
['salePaidInput', 'salePriceInput', 'saleQtyInput'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid('salePriceInput', 'saleQtyInput', 'salePaidInput', 'salePaidHint', 'salePaidNone')));
['posPaid', 'posPrice', 'posQty'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid('posPrice', 'posQty', 'posPaid', 'posPaidHint', 'posPaidNone')));
document.getElementById('salePaidNone')?.addEventListener('click', () => {
  document.getElementById('salePaidInput').value = '0';
  syncPaid('salePriceInput', 'saleQtyInput', 'salePaidInput', 'salePaidHint', 'salePaidNone');
});
document.getElementById('posPaidNone')?.addEventListener('click', () => {
  document.getElementById('posPaid').value = '0';
  syncPaid('posPrice', 'posQty', 'posPaid', 'posPaidHint', 'posPaidNone');
});

// ====== WHATSAPP BROADCAST ======
let broadcastSelectedIds = [];
let broadcastRecipientsState = {};  // phone -> { name, included }

function pastBuyers() {
  // Unique past buyers from sales history, carrying the (category, size) pairs each
  // one bought so the broadcast can be segmented (e.g. everyone who bought Jeans, or
  // size 34). Keeps the most-recent buyer name + last item for display.
  const map = new Map();
  for (const bag of bags) {
    for (const s of (bag.sales || [])) {
      if (!s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const soldAt = new Date(s.soldAt || 0).getTime();
      let e = map.get(phone);
      if (!e) { e = { phone, name: '', soldAt: -1, lastBought: '', buys: [] }; map.set(phone, e); }
      e.buys.push({ cat: bag.category || '', size: s.size || '' });
      if (soldAt >= e.soldAt) { e.soldAt = soldAt; e.lastBought = bag.name; if (s.buyerName) e.name = s.buyerName; }
      else if (!e.name && s.buyerName) e.name = s.buyerName;
    }
  }
  return [...map.values()].sort((a, b) => b.soldAt - a.soldAt);
}

// ===== Broadcast segmentation: filter recipients by category + size =====
let broadcastFilterCat = 'all';
let broadcastFilterSize = 'all';

function broadcastSortSizes(arr) {
  return arr.sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    return String(a).localeCompare(String(b));
  });
}
function buyerMatchesFilter(b) {
  return (b.buys || []).some(x =>
    (broadcastFilterCat === 'all' || x.cat === broadcastFilterCat) &&
    (broadcastFilterSize === 'all' || x.size === broadcastFilterSize));
}
// Categories / sizes that actually appear in SALES (not the whole catalog).
function soldCategories() {
  const set = new Set();
  bags.forEach(b => { if (b.category && (b.sales || []).length) set.add(b.category); });
  return [...set].sort();
}
function soldSizes(cat) {
  const set = new Set();
  bags.forEach(b => { if (cat !== 'all' && b.category !== cat) return; (b.sales || []).forEach(s => { if (s.size) set.add(s.size); }); });
  return broadcastSortSizes([...set]);
}
function populateBroadcastFilters() {
  const catSel = document.getElementById('broadcastFilterCat');
  const sizeSel = document.getElementById('broadcastFilterSize');
  if (!catSel || !sizeSel) return;
  const cats = soldCategories();
  if (broadcastFilterCat !== 'all' && !cats.includes(broadcastFilterCat)) broadcastFilterCat = 'all';
  catSel.innerHTML = `<option value="all">Any category</option>` + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  catSel.value = broadcastFilterCat;
  const sizes = soldSizes(broadcastFilterCat);
  if (broadcastFilterSize !== 'all' && !sizes.includes(broadcastFilterSize)) broadcastFilterSize = 'all';
  sizeSel.innerHTML = `<option value="all">Any size</option>` + sizes.map(s => `<option value="${escapeHtml(s)}">size ${escapeHtml(s)}</option>`).join('');
  sizeSel.value = broadcastFilterSize;
}
document.getElementById('broadcastFilterCat')?.addEventListener('change', e => {
  broadcastFilterCat = e.target.value;
  broadcastFilterSize = 'all'; // sizes are category-specific — reset when category changes
  populateBroadcastFilters();
  renderBroadcastRecipients();
});
document.getElementById('broadcastFilterSize')?.addEventListener('change', e => {
  broadcastFilterSize = e.target.value;
  renderBroadcastRecipients();
});

function renderBroadcastSelected() {
  const wrap = document.getElementById('broadcastSelectedItems');
  if (!wrap) return;
  if (!broadcastSelectedIds.length) { wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;margin:6px 0;">No items selected — message will be text-only.</p>'; return; }
  wrap.innerHTML = broadcastSelectedIds.map(id => {
    const b = bags.find(x => x.id === id);
    if (!b) return '';
    return `<div class="set-chip"><img src="${b.image}" alt=""><span>${escapeHtml(b.name)}</span><button data-bc-remove="${escapeHtml(id)}" aria-label="Remove">×</button></div>`;
  }).join('');
  wrap.querySelectorAll('[data-bc-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      broadcastSelectedIds = broadcastSelectedIds.filter(id => id !== btn.dataset.bcRemove);
      renderBroadcastSelected();
      renderBroadcastPicker();
      renderBroadcastPreview();
    });
  });
}

function renderBroadcastPicker() {
  const picker = document.getElementById('broadcastItemPicker');
  if (!picker) return;
  const q = (document.getElementById('broadcastItemSearch')?.value || '').toLowerCase().trim();
  const matches = bags
    .filter(b => !broadcastSelectedIds.includes(b.id))
    .filter(b => !q || `${b.name} ${b.category || ''}`.toLowerCase().includes(q))
    .slice(0, 40);
  picker.innerHTML = matches.length
    ? matches.map(b => `
        <button class="set-pick" data-bc-add="${escapeHtml(b.id)}" type="button">
          <img src="${b.image}" alt="">
          <div class="set-pick-body">
            <div class="set-pick-name">${escapeHtml(b.name)}</div>
            <div class="set-pick-meta">${escapeHtml(b.category || '')}${b.price > 0 ? ' · ' + fmtKsh(b.price) : ''}</div>
          </div>
        </button>`).join('')
    : '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No matches.</p>';
  picker.querySelectorAll('[data-bc-add]').forEach(b => {
    b.addEventListener('click', () => {
      broadcastSelectedIds.push(b.dataset.bcAdd);
      renderBroadcastSelected();
      renderBroadcastPicker();
      renderBroadcastPreview();
    });
  });
}

function renderBroadcastRecipients() {
  const wrap = document.getElementById('broadcastRecipients');
  if (!wrap) return;
  populateBroadcastFilters();
  const all = pastBuyers();
  // Initialize state for new buyers (manual deselects persist across filter changes)
  for (const b of all) {
    if (!(b.phone in broadcastRecipientsState)) {
      broadcastRecipientsState[b.phone] = { name: b.name, included: true };
    }
  }
  const buyers = all.filter(buyerMatchesFilter);
  const matchEl = document.getElementById('broadcastFilterMatch');
  if (matchEl) {
    const seg = (broadcastFilterCat === 'all' && broadcastFilterSize === 'all')
      ? 'all buyers'
      : [broadcastFilterCat === 'all' ? null : broadcastFilterCat, broadcastFilterSize === 'all' ? null : 'size ' + broadcastFilterSize].filter(Boolean).join(' · ');
    matchEl.textContent = `${buyers.length} ${buyers.length === 1 ? 'buyer' : 'buyers'}${seg === 'all buyers' ? '' : ' · ' + seg}`;
  }
  if (!all.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No past buyers yet — once you record sales with buyer phones, they\'ll show up here.</p>';
    return;
  }
  if (!buyers.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No past buyers match this segment. Widen the category or size above.</p>';
    return;
  }
  wrap.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <button class="btn-admin" type="button" data-bc-recip="all" style="padding:4px 10px;font-size:11px;">Select all</button>
      <button class="btn-admin" type="button" data-bc-recip="none" style="padding:4px 10px;font-size:11px;">Deselect all</button>
      <span style="font-size:12px;color:var(--ink-faint);margin-left:auto;align-self:center;" id="broadcastSelectedCount"></span>
    </div>
    ${buyers.map(b => {
      const st = broadcastRecipientsState[b.phone];
      return `
        <label class="broadcast-recipient${st.included ? ' on' : ''}">
          <input type="checkbox" data-bc-toggle="${b.phone}" ${st.included ? 'checked' : ''}>
          <span class="broadcast-recipient-name">${escapeHtml(b.name || 'Unknown buyer')}</span>
          <span class="broadcast-recipient-phone">+${b.phone}</span>
          <span class="broadcast-recipient-meta">last: ${escapeHtml(b.lastBought)}</span>
        </label>`;
    }).join('')}
  `;
  wrap.querySelectorAll('[data-bc-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      broadcastRecipientsState[cb.dataset.bcToggle].included = cb.checked;
      cb.closest('.broadcast-recipient').classList.toggle('on', cb.checked);
      updateBroadcastCount();
    });
  });
  wrap.querySelectorAll('[data-bc-recip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const on = btn.dataset.bcRecip === 'all';
      buyers.forEach(b => { broadcastRecipientsState[b.phone].included = on; });
      renderBroadcastRecipients();
    });
  });
  updateBroadcastCount();
}

function updateBroadcastCount() {
  const el = document.getElementById('broadcastSelectedCount');
  if (!el) return;
  const n = Object.values(broadcastRecipientsState).filter(s => s.included).length;
  el.textContent = `${n} selected`;
}

function buildBroadcastMessage(recipientName) {
  const subject = (document.getElementById('broadcastSubject')?.value || '').trim();
  const items = broadcastSelectedIds.map(id => bags.find(b => b.id === id)).filter(Boolean);
  const itemsBlock = items.length
    ? '\n\n' + items.map((b, i) => `${i + 1}. *${b.name}*${b.price > 0 ? ' — ' + fmtKsh(b.price) : ''}`).join('\n')
    : '';
  const lookUrl = 'https://phoneguardstore.essenceautomations.com';
  const greet = recipientName ? `Hi ${recipientName.split(' ')[0]}! ` : 'Hi! ';
  return `${greet}It's Phone Guard Store. ${subject || 'Fresh stock just landed'}.${itemsBlock}\n\nTap to browse: ${lookUrl}\n\nReply here to ask about anything.`;
}

function renderBroadcastPreview() {
  const preview = document.getElementById('broadcastPreview');
  if (!preview) return;
  preview.value = buildBroadcastMessage('{First name}');
}

document.getElementById('broadcastSubject')?.addEventListener('input', renderBroadcastPreview);
document.getElementById('broadcastItemSearch')?.addEventListener('input', renderBroadcastPicker);

document.getElementById('broadcastCopyBtn')?.addEventListener('click', () => {
  navigator.clipboard.writeText(buildBroadcastMessage(''));
  showToast('Message copied — paste it into your WhatsApp broadcast.');
});

// On phones the multi-window approach fails: only the first wa.me link fires before
// the browser is backgrounded by the WhatsApp app, and you can only be in one chat
// at a time. So mobile gets a one-at-a-time stepper; desktop keeps the multi-tab open.
const BC_PROG_KEY = 'ryker_bcprog';
let bcQueue = [];   // [{ phone, name }]
let bcIdx = 0;
function saveBcProgress() { try { localStorage.setItem(BC_PROG_KEY, JSON.stringify({ q: bcQueue, i: bcIdx })); } catch (_) {} }
function clearBcProgress() { try { localStorage.removeItem(BC_PROG_KEY); } catch (_) {} bcQueue = []; bcIdx = 0; }

function renderBroadcastStepper() {
  const el = document.getElementById('broadcastStepper');
  if (!el) return;
  if (!bcQueue.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  if (bcIdx >= bcQueue.length) {
    el.style.display = 'block';
    el.innerHTML = `<div class="bc-step-done">✓ Done — stepped through all ${bcQueue.length} buyer${bcQueue.length === 1 ? '' : 's'}. <button class="btn-admin" id="bcStepClose" type="button">Close</button></div>`;
    document.getElementById('bcStepClose').addEventListener('click', () => { clearBcProgress(); renderBroadcastStepper(); });
    return;
  }
  const r = bcQueue[bcIdx];
  const href = `https://wa.me/${r.phone}?text=${encodeURIComponent(buildBroadcastMessage(r.name))}`;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="bc-step-head">Sending ${bcIdx + 1} of ${bcQueue.length}</div>
    <div class="bc-step-name">${escapeHtml(r.name || 'Unknown buyer')} · +${escapeHtml(r.phone)}</div>
    <div class="bc-step-actions">
      <a class="btn-admin gold" id="bcStepOpen" href="${href}" target="_blank" rel="noopener">Open WhatsApp &amp; send →</a>
      <button class="btn-admin" id="bcStepNext" type="button">Sent ✓ · Next ▸</button>
      <button class="btn-admin" id="bcStepSkip" type="button">Skip</button>
      <button class="btn-admin danger" id="bcStepStop" type="button">Stop</button>
    </div>
    <div class="bc-step-hint">Tap <strong>Open WhatsApp</strong>, press send inside WhatsApp, come back here and tap <strong>Sent ✓ · Next</strong>. Your place is saved if you get interrupted.</div>`;
  document.getElementById('bcStepNext').addEventListener('click', () => { bcIdx++; saveBcProgress(); renderBroadcastStepper(); });
  document.getElementById('bcStepSkip').addEventListener('click', () => { bcIdx++; saveBcProgress(); renderBroadcastStepper(); });
  document.getElementById('bcStepStop').addEventListener('click', () => { clearBcProgress(); renderBroadcastStepper(); showToast('Sending stopped.'); });
}

function restoreBcProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(BC_PROG_KEY) || 'null');
    if (p && Array.isArray(p.q) && p.q.length && p.i < p.q.length) { bcQueue = p.q; bcIdx = p.i; renderBroadcastStepper(); }
    else clearBcProgress();
  } catch (_) {}
}

const BC_IS_MOBILE = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

document.getElementById('broadcastStartBtn')?.addEventListener('click', async () => {
  const recipients = pastBuyers().filter(b => buyerMatchesFilter(b) && broadcastRecipientsState[b.phone]?.included);
  if (!recipients.length) { showToast('Pick at least one recipient.'); return; }
  if (BC_IS_MOBILE) {
    // Phone: step through one buyer at a time (multi-tab doesn't work on mobile).
    if (!await confirmAction(`Send to ${recipients.length} buyer${recipients.length === 1 ? '' : 's'}, one at a time. For each: tap Open WhatsApp, send, come back, tap Next. OK?`, 'Start')) return;
    bcQueue = recipients.map(r => ({ phone: r.phone, name: r.name }));
    bcIdx = 0;
    saveBcProgress();
    renderBroadcastStepper();
    document.getElementById('broadcastStepper').scrollIntoView({ behavior: 'auto', block: 'center' });
    return;
  }
  // Desktop: open one tab per buyer, throttled so popups aren't blocked.
  if (!await confirmAction(`Open ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}, one per buyer. Send each one manually. OK?`)) return;
  let i = 0;
  function next() {
    if (i >= recipients.length) {
      document.getElementById('broadcastStatus').textContent = `✓ Opened ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}.`;
      return;
    }
    const r = recipients[i++];
    const msg = buildBroadcastMessage(r.name);
    window.open(`https://wa.me/${r.phone}?text=${encodeURIComponent(msg)}`, '_blank');
    document.getElementById('broadcastStatus').textContent = `Opening ${i} of ${recipients.length}…`;
    setTimeout(next, 700);
  }
  next();
});
restoreBcProgress();

// ====== INSIGHTS (per-browser localStorage from the public site) ======
const INSIGHTS_KEY = 'ryker_analytics';
function loadInsights() {
  try { return JSON.parse(localStorage.getItem(INSIGHTS_KEY) || '{}'); } catch { return {}; }
}
// Pull the shop-wide aggregate from the worker. Falls back to this device's
// localStorage only if the worker is unreachable (offline / down).
async function fetchInsights() {
  try {
    const res = await fetch(`${API_BASE}/api/insights`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    if (res.ok) return await res.json();
  } catch (_) {}
  return null;
}
async function renderInsights() {
  const stats = (await fetchInsights()) || loadInsights();
  const grid = document.getElementById('insightsKpiGrid');
  if (!grid) return;

  const total = (map = {}) => Object.values(map).reduce((a, b) => a + b, 0);
  grid.innerHTML = [
    { label: 'Item views', val: total(stats.itemViews), sub: 'lightbox opens' },
    { label: 'Enquiries', val: total(stats.itemEnquiries), sub: 'WhatsApp clicks', cls: 'success' },
    { label: 'Saved (heart)', val: total(stats.itemWishlist), sub: 'wishlist adds' },
    { label: 'IG clicks', val: total(stats.itemIgClicks), sub: 'View on IG taps' },
  ].map(k => `
    <div class="inv-kpi ${k.cls || ''}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${(k.val || 0).toLocaleString()}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  function topItems(map = {}, n = 6) {
    return Object.entries(map)
      .map(([id, count]) => ({ id, count, bag: bags.find(b => b.id === id) }))
      .filter(x => x.bag)
      .sort((a, b) => b.count - a.count).slice(0, n);
  }
  function renderTopList(list, emptyMsg) {
    if (!list.length) return `<p style="color:#999;font-size:13px;">${emptyMsg}</p>`;
    return list.map(x => `
      <div class="recent-row">
        <img src="${x.bag.image}" alt="${escapeHtml(x.bag.name)}">
        <div class="recent-body">
          <div class="recent-name">${escapeHtml(x.bag.name)}</div>
          <div class="recent-meta">${x.count} ${x.count === 1 ? 'time' : 'times'} · ${escapeHtml(x.bag.category || '')}</div>
        </div>
      </div>`).join('');
  }
  document.getElementById('insightsTopViews').innerHTML = renderTopList(topItems(stats.itemViews), 'No views yet.');
  document.getElementById('insightsTopEnquiries').innerHTML = renderTopList(topItems(stats.itemEnquiries), 'No enquiries yet.');

  // Search gaps — top no-result queries
  const gapsEl = document.getElementById('insightsSearchGaps');
  const gaps = Object.entries(stats.searchNoResults || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  gapsEl.innerHTML = gaps.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px;">${gaps.map(([q, n]) => `<span class="search-gap-pill"><strong>"${escapeHtml(q)}"</strong> · ${n}×</span>`).join('')}</div>`
    : '<p style="color:#999;font-size:13px;">No empty searches yet — shoppers find what they look for.</p>';
}

document.getElementById('insightsResetBtn')?.addEventListener('click', async () => {
  if (accountSuspended) { showToast(SUSPENDED_MSG); return; }
  if (!await confirmAction('Reset Insights for the whole shop? This clears the site-wide totals from every device and cannot be undone.', 'Reset')) return;
  try {
    await fetch(`${API_BASE}/api/insights-reset`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  } catch (_) {}
  localStorage.removeItem(INSIGHTS_KEY);
  await renderInsights();
  showToast('Insights reset for the whole shop.');
});

// Admin item search — debounced
const adminItemSearchInput = document.getElementById('adminItemSearch');
let adminSearchTimer;
adminItemSearchInput?.addEventListener('input', () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    adminItemSearch = adminItemSearchInput.value;
    renderList();
  }, 160);
});

// ====== INSTAGRAM BULK SYNC ======
// Mandatory companion to the per-post IG quick-add — owner clicks "Check for
// new posts", reviews AI-classified previews, then commits the approved
// subset. Dedupe is server-side by `ig_<shortcode>` so the button is
// idempotent and never re-adds an item already in the catalog.
const IG_USER_ID = '13528649848';
const STORE_CATEGORIES = ['iPhone Cases', 'Samsung Cases', 'Google Pixel Cases', 'OnePlus Cases', 'Phone Cases', 'iPad Cases', 'Tablet Cases', 'MacBook Cases', 'Screen Protectors', 'Accessories'];

let igSyncCandidates = [];

const igSyncCheckBtn = document.getElementById('igSyncCheckBtn');
const igSyncCommitBtn = document.getElementById('igSyncCommitBtn');
const igSyncCancelBtn = document.getElementById('igSyncCancelBtn');
const igSyncStatus = document.getElementById('igSyncStatus');
const igSyncListEl = document.getElementById('igSyncList');
const igSyncCommitRow = document.getElementById('igSyncCommitRow');

igSyncCheckBtn?.addEventListener('click', checkForNewIgPosts);
igSyncCancelBtn?.addEventListener('click', resetIgSync);
igSyncCommitBtn?.addEventListener('click', commitIgSync);

async function checkForNewIgPosts() {
  if (accountSuspended) { igSyncStatus.textContent = '✗ ' + SUSPENDED_MSG; return; }
  igSyncCheckBtn.disabled = true;
  igSyncStatus.textContent = 'Checking Instagram…';
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/api/ig-discover?user_id=${IG_USER_ID}&limit=20`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    igSyncCandidates = data.items || [];
    if (!igSyncCandidates.length) {
      igSyncStatus.textContent = '✓ Catalog is up to date. No new posts on Instagram.';
      igSyncCheckBtn.disabled = false;
      return;
    }
    igSyncStatus.textContent = `Found ${igSyncCandidates.length} new post${igSyncCandidates.length === 1 ? '' : 's'}. Review below, then add.`;
    renderIgSyncList();
    igSyncCommitRow.style.display = 'flex';
  } catch (err) {
    igSyncStatus.textContent = '✗ ' + err.message;
  } finally {
    igSyncCheckBtn.disabled = false;
  }
}

function renderIgSyncList() {
  igSyncListEl.innerHTML = igSyncCandidates.map((it, i) => {
    const s = it.suggested || {};
    // New-stock: stock keyed by device model { "iPhone 15":1, ... }. Show every
    // detected size as a comma-list so the owner sees the full SKU array at
    // a glance ("M, L, XL" not "M×1 · L×1 · XL×1" — too noisy when most are 1).
    const stockKeys = Object.keys(s.stock || {});
    const stockText = stockKeys.length ? stockKeys.join(', ') : 'One Size';
    const captionShort = (it.caption || '').replace(/\s+/g, ' ').slice(0, 120);
    const catOpts = STORE_CATEGORIES.map(c => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c}</option>`).join('');
    return `
      <div class="ig-sync-row" data-idx="${i}">
        <label class="ig-sync-check">
          <input type="checkbox" data-ig-pick="${i}" checked>
        </label>
        <img src="${escapeHtml(it.imageUrl)}" alt="" referrerpolicy="no-referrer">
        <div class="ig-sync-body">
          <div class="ig-sync-row-1">
            <input type="text" class="ig-sync-name" data-ig-name="${i}" value="${escapeHtml(s.name || '')}" placeholder="Name">
            <select class="ig-sync-cat" data-ig-cat="${i}">${catOpts}</select>
          </div>
          <div class="ig-sync-row-2">
            <span class="ig-sync-size">${escapeHtml(stockText)}</span>
            <a href="${escapeHtml(it.postUrl)}" target="_blank" rel="noopener" class="ig-sync-postlink">view on IG ↗</a>
          </div>
          <div class="ig-sync-caption">${escapeHtml(captionShort)}</div>
        </div>
      </div>`;
  }).join('');
}

function resetIgSync() {
  igSyncCandidates = [];
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  igSyncStatus.textContent = '';
}

async function commitIgSync() {
  if (accountSuspended) { igSyncStatus.textContent = '✗ ' + SUSPENDED_MSG; return; }
  const picks = [];
  igSyncCandidates.forEach((it, i) => {
    const cb = igSyncListEl.querySelector(`[data-ig-pick="${i}"]`);
    if (!cb || !cb.checked) return;
    const nameEl = igSyncListEl.querySelector(`[data-ig-name="${i}"]`);
    const catEl = igSyncListEl.querySelector(`[data-ig-cat="${i}"]`);
    picks.push({
      shortcode: it.shortcode,
      name: (nameEl?.value || it.suggested?.name || '').trim() || 'New Item',
      category: catEl?.value || it.suggested?.category || 'Shirts',
      stock: it.suggested?.stock || { 'One Size': 1 },
      description: it.suggested?.description || '',
      imageUrls: it.imageUrls || [it.imageUrl],
      takenAt: it.takenAt,
    });
  });
  if (!picks.length) { showToast('Tick at least one item to add.'); return; }
  igSyncCommitBtn.disabled = true;
  igSyncCommitBtn.textContent = `Adding ${picks.length}…`;
  try {
    const res = await fetch(`${API_BASE}/api/ig-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ items: picks }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`Added ${data.added} item${data.added === 1 ? '' : 's'} from Instagram.`);
    igSyncStatus.textContent = `✓ Added ${data.added}. ${data.errors?.length ? `(${data.errors.length} failures)` : ''}`;
    resetIgSync();
    await loadData();
    renderList();
    renderDashboard();
    renderInventory();
  } catch (err) {
    showToast('Error: ' + err.message);
    igSyncStatus.textContent = '✗ ' + err.message;
  } finally {
    igSyncCommitBtn.disabled = false;
    igSyncCommitBtn.textContent = 'Add selected items';
  }
}

async function init() {
  showToast('Loading…');
  const catSel = document.getElementById('categoryInput');
  if (catSel) catSel.addEventListener('change', toggleNewCategoryInput);
  await loadData();
  renderSuspendedBanner();
  renderList();
  renderDashboard();
  renderInventory();
  renderBroadcastSelected();
  renderBroadcastPicker();
  renderBroadcastRecipients();
  renderBroadcastPreview();
  renderClients();
  if (typeof renderOwed === 'function') renderOwed();
  renderInsights();
  initNavScrollSpy();
}

/* ===== Nav scrollspy — highlight the section currently in view ===== */
function initNavScrollSpy() {
  const nav = document.getElementById('adminNav');
  if (!nav) return;
  const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
    .map(a => ({ a, section: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter(x => x.section);
  if (!items.length) return;

  let ticking = false;
  function update() {
    ticking = false;
    const probe = nav.offsetHeight + 24; // line just below the sticky nav
    let current = items[0];
    for (const item of items) {
      if (item.section.getBoundingClientRect().top - probe <= 0) current = item;
    }
    // near the bottom of the page → activate the last section
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      current = items[items.length - 1];
    }
    items.forEach(({ a }) => a.classList.toggle('active', a === current.a));
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();
}

// ====== POS — SELL IN STORE (counter checkout) + RECEIPTS ======
// Reuses the same sales engine as the Record-sale modal: every counter sale
// goes through apiMutateAndPublish (fetch-merge-publish), decrements stock, and
// pushes a sales[] entry tagged { paymentMethod, channel:'shop' } so it shows in
// the Sales dashboard + the Cash/M-Pesa "today" split.
let posItemId = '';
let posPayMethod = 'cash';
let lastPosSale = null;

function posWaPhone(p) {
  let d = String(p || '').replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (d.startsWith('7') || d.startsWith('1')) d = '254' + d;
  return d;
}

function posRenderResults(q) {
  const box = document.getElementById('posItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = bags.filter(b => (b.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(b => {
        const units = Object.values(b.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);
        const meta = Object.keys(b.stock || {}).length ? `${units} in stock` : fmtKsh(b.price);
        return `<button type="button" class="client-item-opt" data-id="${b.id}">${escapeHtml(b.name)}<span>${meta}</span></button>`;
      }).join('')
    : '<div class="client-item-empty">No items match.</div>';
  box.style.display = '';
}

function posSelectItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  posItemId = id;
  document.getElementById('posItemSearch').value = bag.name;
  document.getElementById('posItemResults').style.display = 'none';
  const sizeSel = document.getElementById('posSize');
  sizeSel.innerHTML = '';
  const inStock = Object.entries(bag.stock || {}).filter(([, q]) => q > 0);
  if (inStock.length) inStock.forEach(([sz, q]) => { const o = document.createElement('option'); o.value = sz; o.textContent = `${sz} (${q} in stock)`; sizeSel.appendChild(o); });
  else { const o = document.createElement('option'); o.value = 'One size'; o.textContent = 'One size'; sizeSel.appendChild(o); }
  document.getElementById('posQty').value = 1;
  document.getElementById('posPrice').value = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : (bag.price || '');
  document.getElementById('posChosen').innerHTML = `Selling <strong>${escapeHtml(bag.name)}</strong> · <button type="button" id="posClearItem">change</button>`;
  document.getElementById('posChosen').style.display = '';
  document.getElementById('posSaleFields').style.display = '';
  document.getElementById('posReceiptPanel').style.display = 'none';
}

function posReset() {
  posItemId = ''; posPayMethod = 'cash';
  ['posItemSearch', 'posBuyerName', 'posBuyerPhone', 'posPaid'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
  const _ph = document.getElementById('posPaidHint'); if (_ph) _ph.style.display = 'none';
  document.getElementById('posPaidNone')?.classList.remove('active');
  document.getElementById('posItemResults').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posReceiptPanel').style.display = 'none';
  document.getElementById('posCustomerFields').style.display = '';
  document.querySelectorAll('#posPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'cash'));
}

function posReceiptText(s) {
  const total = s.amount * s.qty;
  return [
    `*Phone Guard Store* receipt`,
    `${s.name} (Size ${s.size}) x${s.qty}`,
    `Total: ${fmtKsh(total)}. Paid by ${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}.`,
    `Thank you for shopping with us. Iconic Business Plaza, Moi Avenue, Nairobi.`,
  ].join('\n');
}

function showPosReceipt(s) {
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posItemSearch').value = '';
  const total = s.amount * s.qty;
  const pay = s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash';
  document.getElementById('posReceiptSummary').innerHTML =
    `<strong>${escapeHtml(s.name)}</strong> · Size ${escapeHtml(s.size)} · ${s.qty} item(s)<br>${fmtKsh(total)} · paid by ${pay}`;
  const wa = document.getElementById('posWaReceiptBtn');
  if (s.buyerPhone && s.buyerPhone.replace(/[^0-9]/g, '').length >= 9) {
    wa.href = `https://wa.me/${posWaPhone(s.buyerPhone)}?text=${encodeURIComponent(posReceiptText(s))}`;
    wa.style.display = '';
  } else { wa.style.display = 'none'; }
  document.getElementById('posReceiptPanel').style.display = '';
}

function posPrintReceipt() {
  if (!lastPosSale) return;
  const s = lastPosSale, total = s.amount * s.qty, d = new Date(s.soldAt);
  document.getElementById('posReceiptPrint').innerHTML = `
    <div class="rcpt">
      <div class="rcpt-head">Phone Guard Store</div>
      <div class="rcpt-sub">Iconic Business Plaza, Moi Avenue, Nairobi<br>0112 440060</div>
      <hr>
      <div class="rcpt-row"><span>${escapeHtml(s.name)}</span></div>
      <div class="rcpt-row"><span>Size ${escapeHtml(s.size)} · ${s.qty} × ${fmtKsh(s.amount)}</span><span>${fmtKsh(total)}</span></div>
      <hr>
      <div class="rcpt-row rcpt-total"><span>TOTAL</span><span>${fmtKsh(total)}</span></div>
      <div class="rcpt-row"><span>Paid by</span><span>${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}</span></div>
      <div class="rcpt-date">${d.toLocaleString('en-GB')}</div>
      <div class="rcpt-foot">Thank you for shopping with us!</div>
    </div>`;
  window.print();
}

async function recordPosSale() {
  const targetId = posItemId;
  if (!targetId) { showToast('Pick an item first.'); return; }
  if (!bags.find(b => b.id === targetId)) { showToast('Item not found — refresh.'); return; }
  const size = document.getElementById('posSize').value;
  const qty = parseInt(document.getElementById('posQty').value, 10) || 1;
  const priceRaw = parseInt(document.getElementById('posPrice').value, 10);
  const name = document.getElementById('posBuyerName').value.trim();
  const phone = document.getElementById('posBuyerPhone').value.trim().replace(/[^0-9+]/g, '');
  const soldAt = new Date().toISOString();
  const _bag = bags.find(b => b.id === targetId);
  const _amt = isNaN(priceRaw) ? (_bag?.price || 0) : priceRaw;
  const _paidRaw = (document.getElementById('posPaid')?.value || '').trim();
  const _paid = _paidRaw === '' ? (_amt * qty) : Math.min(_amt * qty, Math.max(0, parseInt(_paidRaw, 10) || 0));
  if ((_amt * qty - _paid) > 0 && phone.replace(/[^0-9]/g, '').length < 9) {
    if (!await confirmAction("No phone saved for this customer. Without a phone you can't track or collect this balance under their name. Save the sale anyway?", 'Save anyway')) return;
  }
  const btn = document.getElementById('posRecordBtn'); btn.disabled = true;
  try {
    let soldName = '', amount = 0, posAmountPaid = 0;
    await apiMutateAndPublish(() => {
      const bag = bags.find(b => b.id === targetId);
      if (!bag) throw new Error('Item no longer exists — refresh admin');
      amount = isNaN(priceRaw) ? (bag.price || 0) : priceRaw;
      const _posTotal = amount * qty;
      const _posPaidRaw = (document.getElementById('posPaid')?.value || '').trim();
      posAmountPaid = _posPaidRaw === '' ? _posTotal : Math.min(_posTotal, Math.max(0, parseInt(_posPaidRaw, 10) || 0));
      if (bag.stock && bag.stock[size] !== undefined) bag.stock[size] = Math.max(0, bag.stock[size] - qty);
      if (!bag.sales) bag.sales = [];
      bag.sales.push({ size, qty, salePrice: amount, amountPaid: posAmountPaid, paymentMethod: posPayMethod, channel: 'shop', buyerName: name, buyerPhone: phone, notes: '', soldAt });
      soldName = bag.name;
      if (phone.replace(/[^0-9]/g, '').length >= 9) {
        if (!Array.isArray(clients)) clients = [];
        const norm = phone.replace(/[^0-9]/g, '');
        const existing = clients.find(c => String(c.phone).replace(/[^0-9]/g, '') === norm);
        if (existing) { if (name) existing.name = name; }
        else clients.push({ id: 'c_' + Date.now(), name: name || '', phone, note: '', createdAt: soldAt });
      }
    });
    lastPosSale = { name: soldName, size, qty, amount, paid: posAmountPaid, balance: (amount * qty) - posAmountPaid, paymentMethod: posPayMethod, buyerName: name, buyerPhone: phone, soldAt };
    renderList(); renderDashboard(); renderInventory();
    if (typeof renderClients === 'function') renderClients();
    if (typeof renderOwed === 'function') renderOwed();
    showPosReceipt(lastPosSale);
    showToast(`Sold ${qty}× ${size} · ${fmtKsh(amount * qty)}`);
  } catch (e) { showToast('Error: ' + e.message); }
  finally { btn.disabled = false; }
}

document.getElementById('posItemSearch')?.addEventListener('input', e => {
  posItemId = '';
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  posRenderResults(e.target.value.trim());
});
document.getElementById('posItemResults')?.addEventListener('click', e => {
  const opt = e.target.closest('.client-item-opt');
  if (opt) posSelectItem(opt.dataset.id);
});
document.getElementById('posChosen')?.addEventListener('click', e => { if (e.target.id === 'posClearItem') posReset(); });
document.getElementById('posPay')?.addEventListener('click', e => {
  const b = e.target.closest('.pos-pay-btn'); if (!b) return;
  posPayMethod = b.dataset.pay;
  document.querySelectorAll('#posPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
});
document.getElementById('posAddCustomerToggle')?.addEventListener('click', () => {
  const f = document.getElementById('posCustomerFields'); f.style.display = f.style.display === 'none' ? '' : 'none';
});
document.getElementById('posRecordBtn')?.addEventListener('click', recordPosSale);
document.getElementById('posCancelBtn')?.addEventListener('click', posReset);
document.getElementById('posNewSaleBtn')?.addEventListener('click', posReset);
document.getElementById('posPrintReceiptBtn')?.addEventListener('click', posPrintReceipt);

checkAuth();
