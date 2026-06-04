// Phone Guard Store — public catalog
const IMG_VERSION = 'v1';
const API_BASE = 'https://phoneguardstore-api.stawisystems.workers.dev';
(async function () {
  const gallery = document.getElementById('gallery');
  const filterMeta = document.getElementById('filterMeta');
  const availPills = document.getElementById('availPills');
  const catPills = document.getElementById('catPills');
  const sizePills = document.getElementById('sizePills');
  const PAGE_SIZE = 15;
  const NEW_DAYS = 7;
  const LOW_STOCK = 3;
  const WISHLIST_KEY = 'pgs_wishlist';
  let items = [];
  let settings = {};
  let suspended = false;
  let currentAvail = 'all';
  let currentCat = 'all';
  let currentSize = 'all';
  let currentSort = 'default';
  let currentSearch = '';
  let currentPage = 1;
  let wishlist = new Set(JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]'));

  // IntersectionObserver for gallery cards. Each new card from render() gets
  // observed; once it scrolls into view (or already is, e.g. after a filter
  // change while gallery is visible), the .in-view class un-pauses its CSS
  // fade-up animation. One-shot per element.
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cardObserver = (window.IntersectionObserver && !reducedMotion)
    ? new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            e.target.classList.add('in-view');
            cardObserver.unobserve(e.target);
          }
        });
      }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' })
    : null;

  // Per-browser tracking. Admin reads the same localStorage on the same device.
  const ANALYTICS_KEY = 'pgs_analytics';
  // Mirror a key action to Google Analytics as an event, so GA reflects real
  // intent (Enquire taps, item views) instead of engagement-time — which reads
  // near-zero for this funnel (visitors bounce straight to WhatsApp, and
  // link-preview bots load pages without ever engaging). No-op if GA absent.
  function gaEvent(name, params) {
    try { if (window.gtag) window.gtag('event', name, params || {}); } catch (_) {}
  }

  function track(metric, key) {
    if (!key) return;
    try {
      const data = JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '{}');
      data[metric] = data[metric] || {};
      data[metric][key] = (data[metric][key] || 0) + 1;
      data._lastUpdated = new Date().toISOString();
      localStorage.setItem(ANALYTICS_KEY, JSON.stringify(data));
    } catch (_) {}
    // Also report to the worker so the admin sees site-wide totals across all
    // visitors and devices, not just this browser. Fire-and-forget; never
    // blocks or errors the UI. text/plain keeps sendBeacon CORS-preflight-free
    // (the worker parses the body as JSON regardless of content-type).
    try {
      const payload = JSON.stringify({ metric, key });
      const blob = new Blob([payload], { type: 'text/plain' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${API_BASE}/api/track`, blob);
      } else {
        fetch(`${API_BASE}/api/track`, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
      }
    } catch (_) {}
  }

  function saveWishlist() {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify([...wishlist]));
    const btn = document.getElementById('wishlistBtn');
    if (btn) btn.querySelector('.wl-count').textContent = wishlist.size || '';
    btn?.classList.toggle('has-items', wishlist.size > 0);
  }

  // Per-item deterministic base count (7..20) + 1 if the visitor wishlisted it.
  // Social-proof signal without inventing fake activity. Same pattern as
  // ThriftLux. Hash on item.id so the number stays stable across reloads.
  function itemBaseLikes(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return 7 + Math.abs(h) % 14;
  }
  function itemLikeCount(id) {
    return itemBaseLikes(id) + (wishlist.has(id) ? 1 : 0);
  }

  function isNew(item) {
    if (!item.createdAt) return false;
    const days = (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    return days < NEW_DAYS;
  }

  function itemTimestamp(item) {
    if (item.createdAt) return new Date(item.createdAt).getTime();
    const m = item.id?.match(/_(\d{10,})/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function itemImages(item) {
    if (item.images && item.images.length) return item.images;
    return item.image ? [item.image] : [];
  }

  async function loadData() {
    try {
      const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
      const json = await res.json();
      items = json.bags || [];
      settings = json.settings || {};
      suspended = !!json.suspended;
    } catch (e) {
      try {
        const res = await fetch('data.json');
        const json = await res.json();
        items = json.bags || [];
        settings = json.settings || {};
      } catch (e2) { items = []; }
    }
  }

  function fmtPrice(n) { return 'Ksh ' + Number(n).toLocaleString('en-KE'); }

  function totalStock(item) {
    if (!item.stock || Object.keys(item.stock).length === 0) return 1; // unconfigured = treat as in stock
    return Object.values(item.stock).reduce((s, q) => s + (q || 0), 0);
  }

  function availSizes(item) {
    if (!item.stock || Object.keys(item.stock).length === 0) return [];
    const hasSales = (item.sales || []).length > 0;
    const sizes = !hasSales
      ? Object.keys(item.stock)
      : Object.entries(item.stock).filter(([, q]) => q > 0).map(([s]) => s);
    // "One Size" is a stock placeholder for sizeless items — hide from chips/filter
    return sizes.filter(s => s !== 'One Size').sort(sortSize);
  }

  function isSoldOut(item) {
    // Only "sold out" if real sales have happened AND every size is at 0.
    // A freshly-seeded item with size placeholders at 0 is NOT sold out.
    if (!item.stock || Object.keys(item.stock).length === 0) return false;
    const allZero = Object.values(item.stock).every(q => (q || 0) === 0);
    if (!allZero) return false;
    const hasSales = (item.sales || []).length > 0;
    return hasSales;
  }

  // Markdown / sale: on sale when salePrice is set, > 0, below price, and not sold out.
  // effectivePrice = what the buyer pays now; discountPct = the % off. New-stock: a
  // fully-sold item drops off automatically (isOnSale requires !isSoldOut).
  function isOnSale(item) {
    return !isSoldOut(item) && Number(item.salePrice) > 0 && Number(item.salePrice) < Number(item.price);
  }
  function effectivePrice(item) { return isOnSale(item) ? Number(item.salePrice) : Number(item.price || 0); }
  function discountPct(item) { return Math.round((1 - Number(item.salePrice) / Number(item.price)) * 100); }

  function enquireBody(item, soldOut, selectedSize) {
    const avail = availSizes(item);
    let sizePart = '';
    if (!soldOut) {
      if (selectedSize) sizePart = ` (${selectedSize})`;
      else if (avail.length === 1) sizePart = ` (${avail[0]})`;
      // multi-size with nothing selected → no size in body; click handler blocks before reaching here
    }
    const pricePart = isOnSale(item)
      ? ` (on sale ${fmtPrice(item.salePrice)}, was ${fmtPrice(item.price)})`
      : (item.price > 0 ? ` (${fmtPrice(item.price)})` : '');
    return soldOut
      ? `Hi Phone Guard Store! I saw *${item.name}* is sold out. Will it be back in stock? Please let me know.`
      : `Hi Phone Guard Store! I'd like to check availability of *${item.name}*${sizePart}${pricePart} from your catalog.`;
  }

  function whatsappLink(item, soldOut, selectedSize) {
    const phone = settings.whatsappNumber || '254112440060';
    const body = enquireBody(item, soldOut, selectedSize);
    // Append the item's /p/<id> share page — WhatsApp previews it as a card with the
    // product photo + name + price. Still opens straight to WhatsApp (no app picker).
    const shareUrl = item.id ? `${API_BASE}/p/${encodeURIComponent(item.id)}` : '';
    const msg = shareUrl ? `${body}\n\n${shareUrl}` : body;
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }

  function showToast(msg) {
    let toast = document.getElementById('publicToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'publicToast';
      toast.className = 'public-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getCategories() {
    return [...new Set(items.map(i => i.category).filter(Boolean))].sort();
  }

  const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  function sortSize(a, b) {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  }

  function getAllSizesForFilter() {
    const pool = currentCat === 'all' ? items : items.filter(i => i.category === currentCat);
    const all = new Set();
    pool.forEach(i => availSizes(i).forEach(s => all.add(s)));
    return [...all].sort(sortSize);
  }

  function buildCatPills() {
    const cats = getCategories();
    if (!cats.length) { catPills.innerHTML = ''; return; }
    catPills.innerHTML = [
      `<button class="pill pill--cat ${currentCat === 'all' ? 'active' : ''}" data-cat="all">All styles</button>`,
      ...cats.map(c => `<button class="pill pill--cat ${currentCat === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
    ].join('');
    catPills.querySelectorAll('.pill--cat').forEach(p => {
      p.addEventListener('click', () => {
        catPills.querySelectorAll('.pill--cat').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        currentCat = p.dataset.cat;
        currentSize = 'all';
        currentPage = 1;
        render();
      });
    });
  }

  function buildSizePills() {
    const sizes = getAllSizesForFilter();
    if (sizes.length < 2) { sizePills.innerHTML = ''; return; }
    sizePills.innerHTML = [
      `<button class="pill pill--size ${currentSize === 'all' ? 'active' : ''}" data-size="all">All sizes</button>`,
      ...sizes.map(s => `<button class="pill pill--size ${currentSize === s ? 'active' : ''}" data-size="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
    ].join('');
    sizePills.querySelectorAll('.pill--size').forEach(p => {
      p.addEventListener('click', () => {
        sizePills.querySelectorAll('.pill--size').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        currentSize = p.dataset.size;
        currentPage = 1;
        render();
      });
    });
  }

  function sizeMatch(item) {
    if (currentSize === 'all') return true;
    const avail = availSizes(item);
    if (avail.includes(currentSize)) return true;
    const target = parseFloat(currentSize);
    if (!isNaN(target)) {
      for (const s of avail) {
        const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (range && target >= parseFloat(range[1]) && target <= parseFloat(range[2])) return true;
      }
    }
    return false;
  }

  const WA_SVG = `<svg class="wa-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>`;

  const IG_SVG = `<svg class="ig-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>`;

  function render() {
    buildCatPills();
    buildSizePills();

    // Search match — case-insensitive, fuzzy across name + description + category
    const q = currentSearch.trim().toLowerCase();
    function searchMatch(item) {
      if (!q) return true;
      const hay = `${item.name} ${item.description || ''} ${item.category || ''}`.toLowerCase();
      return q.split(/\s+/).every(tok => hay.includes(tok));
    }

    let filtered = items.filter(item => {
      const soldOut = isSoldOut(item);
      const availOk = currentAvail === 'all' ? true
        : currentAvail === 'sold' ? soldOut
        : currentAvail === 'sale' ? isOnSale(item)
        : !soldOut;
      const catOk = currentCat === 'all' || item.category === currentCat;
      return availOk && catOk && sizeMatch(item) && searchMatch(item);
    });

    // Sort
    if (currentSort === 'newest')      filtered.sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
    else if (currentSort === 'priceAsc')  filtered.sort((a, b) => effectivePrice(a) - effectivePrice(b));
    else if (currentSort === 'priceDesc') filtered.sort((a, b) => effectivePrice(b) - effectivePrice(a));
    // 'default' keeps IG feed order (the natural array order)

    const availCount = items.filter(i => !isSoldOut(i)).length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const visible = filtered.slice(start, end);
    const showing = visible.length ? `${start + 1}–${start + visible.length}` : '0';
    filterMeta.textContent = `Showing ${showing} of ${filtered.length} · ${availCount} available`;

    // Track search queries that returned zero results — owner's most valuable insight
    if (currentSearch.trim() && filtered.length === 0) {
      track('searchNoResults', currentSearch.trim().toLowerCase());
    }

    gallery.innerHTML = visible.map(item => {
      const soldOut = isSoldOut(item);
      const onSale = isOnSale(item);
      const avail = availSizes(item);
      const pickRequired = !soldOut && avail.length > 1;
      const sizesHtml = avail.length
        ? `<div class="size-chips${pickRequired ? ' pickable' : ''}">${avail.map(s => `<button type="button" class="size-chip" data-size="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}${pickRequired ? '<span class="size-hint">Pick your model first</span>' : ''}</div>`
        : '';
      const catBadge = item.category ? `<span class="badge-cat">${escapeHtml(item.category)}</span>` : '';
      const isNewItem = isNew(item);
      const totalUnits = totalStock(item);
      const lowStock = !soldOut && totalUnits >= 1 && totalUnits <= LOW_STOCK && item.stock && Object.keys(item.stock).length > 0;
      const saved = wishlist.has(item.id);
      const imgs = itemImages(item);
      const hasMany = imgs.length > 1;
      const carouselInner = imgs.map((src, idx) => `<img class="card-img" src="${src}?${IMG_VERSION}" alt="${escapeHtml(item.name)} ${idx + 1}" loading="${idx === 0 ? 'eager' : 'lazy'}" data-slide="${idx}">`).join('');
      const dots = hasMany ? `<div class="carousel-dots">${imgs.map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}" data-dot="${i}"></span>`).join('')}</div>` : '';
      const arrows = hasMany ? `<button class="carousel-arrow prev" data-carousel="prev" aria-label="Previous">‹</button><button class="carousel-arrow next" data-carousel="next" aria-label="Next">›</button>` : '';

      return `
      <article class="card ${soldOut ? 'sold' : ''}">
        <div class="card-img-wrap${hasMany ? ' has-carousel' : ''}" data-action="zoom" data-id="${escapeHtml(item.id)}">
          <div class="card-carousel" data-current="0" data-count="${imgs.length}">${carouselInner}</div>
          ${dots}
          ${arrows}
          ${soldOut ? '<span class="badge-sold">Sold out</span>' : ''}
          ${!soldOut && onSale ? '<span class="badge-sale">SALE</span>' : ''}
          ${!soldOut && !onSale && isNewItem ? '<span class="badge-new">NEW</span>' : ''}
          ${lowStock ? `<span class="badge-low">Only ${totalUnits} left</span>` : ''}
          ${catBadge}
          <button class="heart-btn ${saved ? 'saved' : ''}" data-wishlist="${escapeHtml(item.id)}" aria-label="${saved ? 'Remove from saved' : 'Save item'}" title="${saved ? 'Saved' : 'Save for later'}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span class="heart-count">${itemLikeCount(item.id)}</span>
          </button>
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(item.name)}</h3>
          <p class="card-desc">${escapeHtml(item.description || '')}</p>
          ${sizesHtml}
          <div class="card-price-row">
            ${onSale
              ? `<span class="card-price-was">${fmtPrice(item.price)}</span><span class="card-price card-price-sale">${fmtPrice(item.salePrice)}</span><span class="price-off">-${discountPct(item)}%</span>`
              : `<span class="card-price">${item.price > 0 ? fmtPrice(item.price) : '<small style="font-style:italic;font-size:14px;">Price on request</small>'}</span>`}
            ${avail.length ? '<a class="size-guide-link" data-action="size-guide">Which fits my device?</a>' : ''}
          </div>
          <div class="card-actions">
            <a class="btn-card primary${soldOut ? ' soldout' : ''}" href="${whatsappLink(item, soldOut)}" target="_blank" rel="noopener">
              ${WA_SVG} ${soldOut ? 'Sold out · notify me' : 'Check availability'}
            </a>
            ${item.instagramUrl ? `<a class="btn-card ig" href="${item.instagramUrl}" target="_blank" rel="noopener" aria-label="360 degree view">${IG_SVG} 360° view</a>` : ''}
          </div>
        </div>
      </article>`;
    }).join('');

    if (!visible.length) {
      gallery.innerHTML = '<p style="color:var(--ink-faint);padding:40px 0;text-align:center;grid-column:1/-1;">No items match this filter.</p>';
    }

    // Observe each card so its fade-up animation un-pauses when it scrolls
    // into view. Cards above the fold (filter/page changes while gallery is
    // visible) fire immediately. Cards below the fold (initial load before
    // user scrolls) wait until they're in view, then animate.
    if (cardObserver) {
      gallery.querySelectorAll('.card').forEach(card => cardObserver.observe(card));
    } else {
      // No IO support OR reduced motion preference — show cards immediately
      gallery.querySelectorAll('.card').forEach(card => card.classList.add('in-view'));
    }

    // Numbered pagination
    const oldPager = document.getElementById('pagerWrap');
    if (oldPager) oldPager.remove();
    if (totalPages > 1) {
      const wrap = document.createElement('div');
      wrap.id = 'pagerWrap';
      wrap.className = 'pager-wrap';
      const pages = pageRange(currentPage, totalPages);
      const btn = (label, page, opts = {}) => {
        const cls = ['pager-btn'];
        if (opts.active) cls.push('active');
        if (opts.disabled) cls.push('disabled');
        if (opts.ellipsis) cls.push('ellipsis');
        const dataPage = opts.disabled || opts.ellipsis ? '' : ` data-page="${page}"`;
        return `<button class="${cls.join(' ')}"${dataPage}${opts.disabled ? ' disabled' : ''}>${label}</button>`;
      };
      wrap.innerHTML = [
        btn('‹', currentPage - 1, { disabled: currentPage === 1 }),
        ...pages.map(p => p === '…' ? btn('…', null, { ellipsis: true }) : btn(p, p, { active: p === currentPage })),
        btn('›', currentPage + 1, { disabled: currentPage === totalPages }),
      ].join('');
      gallery.parentNode.insertBefore(wrap, gallery.nextSibling);
      wrap.querySelectorAll('.pager-btn[data-page]').forEach(b => {
        b.addEventListener('click', () => {
          const p = parseInt(b.dataset.page, 10);
          if (!isNaN(p) && p >= 1 && p <= totalPages && p !== currentPage) {
            currentPage = p;
            render();
            document.getElementById('shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      });
    }
  }

  function pageRange(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (cur > 3) pages.push('…');
    for (let p = Math.max(2, cur - 1); p <= Math.min(total - 1, cur + 1); p++) pages.push(p);
    if (cur < total - 2) pages.push('…');
    pages.push(total);
    return pages;
  }

  availPills.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      availPills.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      currentAvail = p.dataset.avail;
      currentSize = 'all';
      currentPage = 1;
      render();
    });
  });

  // Search input — debounced
  const searchInput = document.getElementById('searchInput');
  let searchTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = searchInput.value;
      currentPage = 1;
      render();
    }, 180);
  });
  document.getElementById('searchClear')?.addEventListener('click', () => {
    searchInput.value = ''; currentSearch = ''; currentPage = 1; render(); searchInput.focus();
  });

  // Sort dropdown
  document.getElementById('sortSelect')?.addEventListener('change', e => {
    currentSort = e.target.value;
    currentPage = 1;
    render();
  });

  // Lightbox
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCap = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  // Carousel state for the lightbox
  let lightboxImages = [];
  let lightboxIndex = 0;
  function updateLightbox() {
    if (!lightboxImages.length) return;
    lightboxImg.src = lightboxImages[lightboxIndex] + '?' + IMG_VERSION;
    const cap = lightboxCap.dataset.baseCaption || '';
    lightboxCap.textContent = cap + (lightboxImages.length > 1 ? `  (${lightboxIndex + 1} / ${lightboxImages.length})` : '');
  }
  function shiftLightbox(delta) {
    if (lightboxImages.length < 2) return;
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    updateLightbox();
  }

  function shiftCardCarousel(wrap, delta) {
    const carousel = wrap.querySelector('.card-carousel');
    if (!carousel) return;
    const count = parseInt(carousel.dataset.count, 10) || 1;
    if (count < 2) return;
    let cur = parseInt(carousel.dataset.current, 10) || 0;
    cur = (cur + delta + count) % count;
    carousel.dataset.current = cur;
    carousel.style.transform = `translateX(-${cur * 100}%)`;
    wrap.querySelectorAll('.carousel-dot').forEach((d, i) => d.classList.toggle('active', i === cur));
  }

  gallery.addEventListener('click', async e => {
    // Wishlist toggle
    const heart = e.target.closest('[data-wishlist]');
    if (heart) {
      e.preventDefault(); e.stopPropagation();
      const id = heart.dataset.wishlist;
      if (wishlist.has(id)) wishlist.delete(id);
      else { wishlist.add(id); track('itemWishlist', id); }
      saveWishlist();
      render();
      return;
    }
    // Size-chip click — select that size, deselect siblings
    const chip = e.target.closest('.size-chip[data-size]');
    if (chip) {
      e.preventDefault(); e.stopPropagation();
      const card = chip.closest('.card');
      card.querySelectorAll('.size-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      // Clear any active prompt + shake
      const chipsRow = card.querySelector('.size-chips');
      chipsRow?.classList.remove('shake');
      chipsRow?.classList.remove('prompted');
      return;
    }
    // Enquire click — enforce size pick when needed
    const enquire = e.target.closest('.btn-card.primary');
    if (enquire) {
      const card = enquire.closest('.card');
      const wrap = card?.querySelector('[data-id]');
      if (!wrap) return;
      const id = wrap.dataset.id;
      const item = items.find(i => i.id === id);
      if (!item) return;
      const soldOut = isSoldOut(item);
      const avail = availSizes(item);
      // Require size selection when multiple sizes exist and item isn't sold out
      if (!soldOut && avail.length > 1) {
        const selected = card.querySelector('.size-chip.selected');
        if (!selected) {
          e.preventDefault();
          showToast('Pick your model first to continue');
          const chips = card.querySelector('.size-chips');
          chips?.classList.add('prompted');     // reveals the inline 'Pick a size first' hint
          chips?.classList.add('shake');
          setTimeout(() => chips?.classList.remove('shake'), 600);
          return;
        }
        // Override the href with the size-specific URL
        enquire.href = whatsappLink(item, false, selected.dataset.size);
      }
      track('itemEnquiries', id);
      gaEvent('enquire', { item_id: id });
      // Enquire opens WhatsApp directly via the wa.me href (anchor, target=_blank).
      // No native share sheet — the OS "select an app" chooser confused buyers.
    }
    const igClick = e.target.closest('.btn-card.ig');
    if (igClick) {
      const card = igClick.closest('.card');
      const wrap = card?.querySelector('[data-id]');
      if (wrap) track('itemIgClicks', wrap.dataset.id);
    }
    // Size guide
    if (e.target.closest('[data-action="size-guide"]')) {
      e.preventDefault();
      openSizeGuide();
      return;
    }
    // Carousel arrows
    const arrow = e.target.closest('[data-carousel]');
    if (arrow) {
      e.preventDefault(); e.stopPropagation();
      const wrap = arrow.closest('.card-img-wrap');
      shiftCardCarousel(wrap, arrow.dataset.carousel === 'next' ? 1 : -1);
      return;
    }
    // Carousel dots
    const dot = e.target.closest('[data-dot]');
    if (dot) {
      e.preventDefault(); e.stopPropagation();
      const wrap = dot.closest('.card-img-wrap');
      const carousel = wrap.querySelector('.card-carousel');
      const target = parseInt(dot.dataset.dot, 10);
      const cur = parseInt(carousel.dataset.current, 10) || 0;
      shiftCardCarousel(wrap, target - cur);
      return;
    }
    // Lightbox zoom
    const wrap = e.target.closest('[data-action="zoom"]');
    if (!wrap) return;
    const id = wrap.dataset.id;
    const item = items.find(i => i.id === id);
    if (!item) return;
    track('itemViews', id);
    gaEvent('item_view', { item_id: id });
    lightboxImages = itemImages(item);
    // Start at the slide the card is currently showing
    const carousel = wrap.querySelector('.card-carousel');
    lightboxIndex = carousel ? parseInt(carousel.dataset.current, 10) || 0 : 0;
    const lbPrice = isOnSale(item) ? `${fmtPrice(item.salePrice)} (was ${fmtPrice(item.price)})` : (item.price > 0 ? fmtPrice(item.price) : '');
    lightboxCap.dataset.baseCaption = `${item.name}${lbPrice ? ' · ' + lbPrice : ''}${isSoldOut(item) ? ' · SOLD OUT' : isOnSale(item) ? ' · ON SALE' : ''}`;
    lightboxImg.alt = item.name;
    updateLightbox();
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  });

  // Touch swipe on cards (basic)
  let touchStartX = null, touchStartY = null, touchWrap = null;
  gallery.addEventListener('touchstart', e => {
    const wrap = e.target.closest('.card-img-wrap.has-carousel');
    if (!wrap) return;
    touchWrap = wrap;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  gallery.addEventListener('touchend', e => {
    if (!touchWrap || touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      shiftCardCarousel(touchWrap, dx < 0 ? 1 : -1);
    }
    touchWrap = null; touchStartX = null; touchStartY = null;
  });

  // Wishlist drawer + Size guide modal
  function openWishlist() {
    const items_saved = items.filter(i => wishlist.has(i.id));
    const modal = document.getElementById('wishlistModal');
    const body = document.getElementById('wishlistBody');
    if (!items_saved.length) {
      body.innerHTML = '<p style="text-align:center;color:var(--ink-faint);padding:24px 0;">No saved items yet. Tap the heart on any item to save it for later.</p>';
    } else {
      body.innerHTML = items_saved.map(i => `
        <div class="wl-row">
          <img src="${i.image}?${IMG_VERSION}" alt="${escapeHtml(i.name)}">
          <div class="wl-row-body">
            <div class="wl-row-name">${escapeHtml(i.name)}</div>
            <div class="wl-row-meta">${i.price > 0 ? fmtPrice(i.price) : 'Price on request'}${i.category ? ' · ' + escapeHtml(i.category) : ''}</div>
          </div>
          <button class="wl-remove" data-remove="${escapeHtml(i.id)}" aria-label="Remove">×</button>
        </div>
      `).join('');
    }
    document.getElementById('wishlistEnquireAll').style.display = items_saved.length ? 'inline-flex' : 'none';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeWishlist() {
    document.getElementById('wishlistModal').classList.remove('open');
    document.body.style.overflow = '';
  }
  document.getElementById('wishlistBtn')?.addEventListener('click', e => { e.preventDefault(); openWishlist(); });
  document.getElementById('wishlistClose')?.addEventListener('click', closeWishlist);
  document.getElementById('wishlistModal')?.addEventListener('click', e => {
    if (e.target.id === 'wishlistModal') return closeWishlist();
    const rm = e.target.closest('[data-remove]');
    if (rm) { wishlist.delete(rm.dataset.remove); saveWishlist(); openWishlist(); render(); }
  });
  document.getElementById('wishlistEnquireAll')?.addEventListener('click', e => {
    e.preventDefault();
    const items_saved = items.filter(i => wishlist.has(i.id));
    if (!items_saved.length) return;
    const phone = settings.whatsappNumber || '254112440060';
    const lines = items_saved.map((i, idx) => `${idx + 1}. *${i.name}*${i.price > 0 ? ' (' + fmtPrice(i.price) + ')' : ''}`);
    const msg = `Hi Phone Guard Store! I'd like to check availability of these saved items:\n\n${lines.join('\n')}\n\nAre they available?`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  });

  function openSizeGuide() {
    document.getElementById('sizeGuideModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSizeGuide() {
    document.getElementById('sizeGuideModal').classList.remove('open');
    document.body.style.overflow = '';
  }
  document.getElementById('sizeGuideClose')?.addEventListener('click', closeSizeGuide);
  document.getElementById('sizeGuideModal')?.addEventListener('click', e => { if (e.target.id === 'sizeGuideModal') closeSizeGuide(); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeWishlist();
    closeSizeGuide();
    if (!document.getElementById('wishlistModal').classList.contains('open') && !document.getElementById('sizeGuideModal').classList.contains('open')) {
      document.body.style.overflow = '';
    }
  });
  function closeLightbox() { lightbox.classList.remove('open'); lightbox.setAttribute('aria-hidden', 'true'); }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => {
    const arrow = e.target.closest('[data-lightbox-arrow]');
    if (arrow) { e.stopPropagation(); shiftLightbox(arrow.dataset.lightboxArrow === 'next' ? 1 : -1); return; }
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'ArrowRight') shiftLightbox(1);
    else if (e.key === 'ArrowLeft') shiftLightbox(-1);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  // Mobile nav — toggle classes on both elements so hamburger animates to X
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  navToggle?.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    document.body.style.overflow = open ? 'hidden' : '';
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.classList.remove('open');
    document.body.style.overflow = '';
  }));

  document.getElementById('year').textContent = new Date().getFullYear();
  saveWishlist();

  // Scroll-triggered fade-up (skips if user prefers reduced motion). One-shot:
  // once an element reveals, the observer stops watching it.
  if (window.IntersectionObserver && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const fadeIO = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          fadeIO.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.fade-up').forEach(el => fadeIO.observe(el));
  } else {
    // Reduced motion or no IO support — show everything immediately
    document.querySelectorAll('.fade-up').forEach(el => el.classList.add('in-view'));
  }

  // Billing kill-switch: when suspended, replace the whole page with a neutral
  // "offline" notice instead of the catalog. Buyers never see a payment reason.
  function showSuspended() {
    document.documentElement.style.overflow = 'hidden';
    const o = document.createElement('div');
    o.id = 'suspendedOverlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:linear-gradient(180deg,#2a1c0f,#0d0a07);color:#e8dcc4;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;font-family:Inter,system-ui,sans-serif;';
    o.innerHTML = '<img src="images/logo-nav.jpg" alt="Phone Guard Store" style="height:54px;background:#fff;border-radius:10px;padding:8px 12px;margin-bottom:28px;">'
      + '<h1 style="font-family:\'Cormorant Garamond\',Georgia,serif;font-weight:500;font-size:clamp(28px,5vw,44px);color:#d4c0a0;margin:0 0 14px;line-height:1.15;">This page is temporarily unavailable</h1>'
      + '<p style="font-size:16px;max-width:440px;line-height:1.6;color:rgba(216,210,196,0.8);margin:0;">Please check back soon.</p>';
    document.body.appendChild(o);
  }

  await loadData();
  if (suspended) { showSuspended(); return; }
  render();
})();
