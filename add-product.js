// Add Product standalone page
(() => {
  const EU_SIZES = Array.from({ length: 15 }, (_, i) => 35 + i); // 35..49
  const state = { colors: [], activeColorId: null, firebase: { db: null, enabled: false } };

  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = (p = 'id') => `${p}-${Math.random().toString(36).slice(2, 9)}`;
  const clampNum = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
  const parseNum = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

  let cachedDefaultCritical = null;
  function getDefaultCriticalLevel() {
    if (Number.isFinite(cachedDefaultCritical)) return cachedDefaultCritical;
    try {
      const raw = localStorage.getItem('inventory_app_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        const val = parseNum(parsed && parsed.lowStockThreshold, NaN);
        if (Number.isFinite(val) && val >= 1) {
          cachedDefaultCritical = clampNum(Math.floor(val), 1, 999);
          return cachedDefaultCritical;
        }
      }
    } catch (e) { /* ignore */ }
    cachedDefaultCritical = 3;
    return cachedDefaultCritical;
  }

  function criticalLevelForSize(s) {
    const cand = s && (s.criticalLevel || s.critical_level || s.critical || s.minStock || s.reorderLevel);
    const n = parseNum(cand, NaN);
    if (Number.isFinite(n) && n >= 1) return clampNum(Math.floor(n), 1, 999);
    return getDefaultCriticalLevel();
  }

  function isSizeCritical(s) {
    const stock = parseNum(s && s.stock, 0);
    const crit = criticalLevelForSize(s);
    return Number.isFinite(crit) ? stock <= crit : false;
  }

  function normalizeVariantImages(images) {
    const arr = Array.isArray(images) ? images.slice(0, 4) : [];
    while (arr.length < 4) arr.push('');
    // Validate data URIs; non-data URLs are returned unchanged.
    return arr.map(x => (x || '').trim()).map(src => normalizeDataUri(src)).filter(Boolean).slice(0,4).concat(Array(4).fill('')).slice(0,4);
  }

  function normalizeDataUri(src) {
    try {
      if (!src) return '';
      src = String(src).trim();
      if (!src.startsWith('data:')) return src;
      src = src.replace(/\s+/g, '');
      if (src.indexOf(';base64,') === -1 && src.indexOf(';base64') !== -1) src = src.replace(/;base64(?!,)/, ';base64,');
      if (src.indexOf(',') === -1) return '';
      if (src.indexOf(';base64,') !== -1) {
        const b64 = src.split(',')[1] || '';
        if (!/^[A-Za-z0-9+/=]+$/.test(b64.replace(/=+$/,''))) return '';
      }
      if (src.length > 900 * 1024) return '';
      return src;
    } catch (e) { return ''; }
  }

  function qrImageUrlFor(data, size) {
    try {
      if (!data) return '';
      const s = size && Number.isFinite(Number(size)) ? Number(size) : 300;
      return 'https://api.qrserver.com/v1/create-qr-code/?size=' + encodeURIComponent(s + 'x' + s) + '&data=' + encodeURIComponent(String(data));
    } catch (e) { return ''; }
  }

  function generateProductSKU(brand, model, category) {
    const prefix = 'SP';
    const clean = (str, len, removeVowels = false) => {
      let s = String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (removeVowels) s = s.replace(/[AEIOU]/g, '');
      if (!s) s = 'X'.repeat(len);
      return s.slice(0, len);
    };
    const b = clean(brand, 3);
    const m = clean(model, 4, false);
    const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return `${prefix}-${b}-${m}-${rand}`;
  }

  function generateSizeSKU(product, color, eu) {
    const clean = (str, len) => {
      let s = String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!s) s = 'X'.repeat(len);
      return s.slice(0, len);
    };
    const base = (product && product.sku) ? String(product.sku).trim() : generateProductSKU(product?.brand, product?.model, product?.category);
    const colorToken = clean((color && (color.code || color.name || color.id)) || '', 4);
    const sizeToken = String(eu || '').replace(/[^0-9]/g, '');
    const sizePart = sizeToken ? `S${sizeToken}` : 'SXX';
    return `${base}-${colorToken}-${sizePart}`;
  }

  function updateSkuPreview() {
    const brand = (qs('#prodBrand')?.value || '').trim();
    const model = (qs('#prodModel')?.value || '').trim();
    const cat = (qs('#prodCategory')?.value || '').trim();
    qs('#prodSKU').value = generateProductSKU(brand, model, cat);
  }

  function addColor() {
    const name = (qs('#variantColorName')?.value || '').trim();
    const code = qs('#variantColorCode')?.value || '#ffffff';
    if (!name) { alert('Enter a color name.'); return; }
    const color = { id: uid('color'), name, code, images: normalizeVariantImages([]), sizes: [] };
    state.colors.push(color);
    state.activeColorId = color.id;
    qs('#variantColorName').value = '';
    renderColors();
  }

  function removeColor(id) {
    state.colors = state.colors.filter(c => c.id !== id);
    if (state.activeColorId === id) {
      state.activeColorId = state.colors[0]?.id || null;
    }
    renderColors();
  }

  function renderColors() {
    const list = qs('#colorList');
    if (!list) return;
    list.innerHTML = state.colors.map(c => {
      const stock = c.sizes.reduce((acc, s) => acc + parseNum(s.stock, 0), 0);
      const imageCount = normalizeVariantImages(c.images).filter(x => x).length;
      return `<div class="color-card ${state.activeColorId === c.id ? 'active' : ''}" data-id="${c.id}">
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="color-dot" style="background:${c.code}"></span>
          <div class="color-meta">
            <strong>${c.name}</strong>
            <span class="muted">${stock} in stock • ${c.sizes.length} sizes • ${imageCount}/4 images</span>
          </div>
        </div>
        <div class="color-actions">
          <button class="secondary" data-action="select">Edit</button>
          <button class="danger" data-action="delete">Delete</button>
        </div>
      </div>`;
    }).join('') || '<p class="muted">No colors yet. Add one above.</p>';

    list.querySelectorAll('.color-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-action="select"]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); state.activeColorId = id; renderColors(); renderWorkspace(); }));
      card.querySelectorAll('[data-action="delete"]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete this color?')) removeColor(id); }));
      card.addEventListener('click', () => { state.activeColorId = id; renderColors(); renderWorkspace(); });
    });

    renderWorkspace();
  }

  function renderWorkspace() {
    const wrap = qs('#colorWorkspace'); if (!wrap) return;
    const color = state.colors.find(c => c.id === state.activeColorId);
    if (!color) {
      wrap.innerHTML = '<p class="muted">Select a color to manage sizes and images. Colors start empty by design.</p>';
      return;
    }
    color.images = normalizeVariantImages(color.images);
    const availableSizes = EU_SIZES.filter(eu => !color.sizes.some(s => Number(s.eu) === Number(eu)));
    wrap.innerHTML = `
      <div class="variant-images">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
          <div>
            <strong>Variant images</strong>
            <p class="helper-text">Exactly 4 images are required for each color (front, side, back, detail).</p>
          </div>
          <span class="chip">${color.images.filter(x => x).length}/4 uploaded</span>
        </div>
        <div class="variant-images-grid">
          ${color.images.map((img, idx) => {
            const label = `Image ${idx + 1}`;
            const preview = img ? `<img src="${img}" alt="${color.name} ${label}">` : `<div class="variant-image-placeholder">${label}</div>`;
            return `
              <div class="variant-image-slot" data-index="${idx}">
                <div class="variant-image-preview">${preview}</div>
                <div class="variant-image-actions">
                  <label class="small-btn">
                    <input type="file" accept="image/*" data-action="upload" data-index="${idx}" style="display:none;">
                    Upload
                  </label>
                  <button type="button" class="ghost danger-text small-btn" data-action="clear" data-index="${idx}">Remove</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>
      <div class="sizes-panel">
        <div class="size-add">
          <label class="chip">Add size (EU 35-49)</label>
          <select id="sizeSelect" style="padding:8px 10px; border:1px solid #ddd; border-radius:10px; min-width:120px;">
            <option value="">Choose size</option>
            ${availableSizes.map(s => `<option value="${s}">${s} EU</option>`).join('')}
          </select>
          <input id="sizeStock" type="number" min="0" step="1" placeholder="Stock" style="width:120px; padding:8px 10px; border:1px solid #ddd; border-radius:10px;" />
          <input id="sizeCritical" type="number" min="1" step="1" placeholder="Critical" aria-label="Critical level" style="width:120px; padding:8px 10px; border:1px solid #ddd; border-radius:10px;" />
          <button id="addSizeBtn" class="secondary" type="button">Add size</button>
        </div>
        <div class="size-list">
          <div class="size-row header" aria-hidden="true">
            <strong>Size</strong>
            <strong>Stock</strong>
            <strong>Critical</strong>
            <span></span>
            <span></span>
          </div>
          ${color.sizes.length ? color.sizes.map(s => `
            <div class="size-row ${isSizeCritical(s) ? 'is-critical' : ''}" data-size="${s.eu}">
              <strong>${s.eu} EU</strong>
              <input type="number" min="0" step="1" value="${parseNum(s.stock, 0)}" data-action="stock" data-size="${s.eu}" />
              <input type="number" min="1" step="1" value="${criticalLevelForSize(s)}" data-action="critical" data-size="${s.eu}" class="critical-input" aria-label="Critical level" />
              <div class="qty-controls">
                <button type="button" class="qty-btn" data-action="decr" data-size="${s.eu}">−</button>
                <button type="button" class="qty-btn" data-action="incr" data-size="${s.eu}">+</button>
              </div>
              <button type="button" class="danger" data-action="remove-size" data-size="${s.eu}">Remove</button>
            </div>`).join('') : '<p class="muted">No sizes yet for this color.</p>'}
        </div>
      </div>
    `;

    // Bind uploads
    wrap.querySelectorAll('[data-action="upload"]').forEach(inp => inp.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const idx = parseNum(e.target.dataset.index, 0);
      const fr = new FileReader();
      fr.onload = () => {
        const clean = normalizeDataUri(fr.result);
        if (!clean) { alert('Uploaded image appears invalid. Please choose a different file.'); return; }
        color.images[idx] = clean;
        renderColors();
      };
      fr.onerror = () => alert('Failed to read image file.');
      fr.readAsDataURL(file);
    }));

    // Bind clear image
    wrap.querySelectorAll('[data-action="clear"]').forEach(btn => btn.addEventListener('click', () => {
      const idx = parseNum(btn.dataset.index, 0);
      color.images[idx] = '';
      renderColors();
    }));

    // Bind add size
    const addBtn = qs('#addSizeBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      const sizeSel = qs('#sizeSelect');
      const stockEl = qs('#sizeStock');
      const critEl = qs('#sizeCritical');
      const eu = parseNum(sizeSel.value, null);
      const stock = clampNum(parseNum(stockEl.value, 0), 0, 9999);
      const criticalLevel = clampNum(parseNum(critEl && critEl.value, getDefaultCriticalLevel()), 1, 999);
      if (!eu || !EU_SIZES.includes(eu)) { alert('Pick a size between EU 35 and 49.'); return; }
      if (color.sizes.some(s => Number(s.eu) === eu)) { alert('Size already added for this color.'); return; }
      color.sizes.push({ eu, stock, criticalLevel, sku: '' });
      sizeSel.value = '';
      stockEl.value = '';
      if (critEl) critEl.value = '';
      renderColors();
    });

    // Bind stock changes and remove
    wrap.querySelectorAll('[data-action="stock"]').forEach(inp => inp.addEventListener('change', (e) => {
      const eu = parseNum(e.target.dataset.size);
      const qty = clampNum(parseNum(e.target.value, 0), 0, 9999);
      const target = color.sizes.find(s => Number(s.eu) === eu);
      if (target) {
        target.stock = qty;
        const row = e.target.closest('.size-row');
        if (row) row.classList.toggle('is-critical', isSizeCritical(target));
      }
    }));
    wrap.querySelectorAll('[data-action="critical"]').forEach(inp => inp.addEventListener('change', (e) => {
      const eu = parseNum(e.target.dataset.size);
      const target = color.sizes.find(s => Number(s.eu) === eu);
      if (target) {
        target.criticalLevel = clampNum(parseNum(e.target.value, getDefaultCriticalLevel()), 1, 999);
        const row = e.target.closest('.size-row');
        if (row) row.classList.toggle('is-critical', isSizeCritical(target));
      }
    }));
    wrap.querySelectorAll('[data-action="remove-size"]').forEach(btn => btn.addEventListener('click', () => {
      const eu = parseNum(btn.dataset.size);
      color.sizes = color.sizes.filter(s => Number(s.eu) !== eu);
      renderColors();
    }));

    // Bind qty +/- buttons
    wrap.querySelectorAll('[data-action="incr"], [data-action="decr"]').forEach(btn => btn.addEventListener('click', () => {
      const eu = parseNum(btn.dataset.size);
      const delta = btn.dataset.action === 'incr' ? 1 : -1;
      const target = color.sizes.find(s => Number(s.eu) === eu);
      if (!target) return;
      target.stock = clampNum((Number(target.stock) || 0) + delta, 0, 9999);
      const row = btn.closest('.size-row');
      if (row) row.classList.toggle('is-critical', isSizeCritical(target));
      renderColors();
    }));
  }

  function gatherProduct() {
    const brand = (qs('#prodBrand')?.value || '').trim();
    const model = (qs('#prodModel')?.value || '').trim();
    const category = (qs('#prodCategory')?.value || '').trim();
    const status = (qs('#prodStatus')?.value || 'published').trim();
    const pOrig = parseNum(qs('#priceOriginal')?.value, 0);
    const pSale = parseNum(qs('#priceSale')?.value, 0);
    const desc = (qs('#prodDescription')?.value || '').trim();
    const skuInput = (qs('#prodSKU')?.value || '').trim();
    const arLink = (qs('#prodARLink')?.value || '').trim();

    const genders = [];
    if (qs('#prodGenderMen')?.checked) genders.push('Men');
    if (qs('#prodGenderWomen')?.checked) genders.push('Women');
    if (qs('#prodGenderUnisex')?.checked || genders.length === 0) genders.push('Unisex');

    const tagsManual = [];
    if (qs('#tagNew')?.checked) tagsManual.push('New');
    if (qs('#tagSale')?.checked) tagsManual.push('Sale');
    if (qs('#tagPreOrder')?.checked) tagsManual.push('Pre-Order');
    if (qs('#tagBestSeller')?.checked) tagsManual.push('Best Seller');

    if (!brand || !model) throw new Error('Brand and Model are required.');
    if (pOrig <= 0) throw new Error('Original price is required.');
    if (!state.colors.length) throw new Error('Add at least one color before saving.');

    const product = {
      id: uid('prod'),
      brand,
      model,
      category,
      status,
      gender: genders,
      pricing: { original: pOrig, sale: pSale || pOrig, cost: 0 },
      description: desc,
      sku: skuInput || generateProductSKU(brand, model, category),
      tagsManual,
      colors: [],
      createdAt: new Date().toISOString()
    };

    if (arLink) {
      product.arLink = arLink;
      product.arQr = qrImageUrlFor(arLink, 300);
    }

    state.colors.forEach(c => {
      const images = normalizeVariantImages(c.images);
      const filledCount = images.filter(x => x).length;
      if (filledCount < 4) throw new Error(`Upload 4 images for color "${c.name}".`);
      if (!c.sizes.length) throw new Error(`Add at least one size for color "${c.name}".`);
      const sizes = c.sizes.map(s => {
        const eu = parseNum(s.eu, null);
        if (!eu || !EU_SIZES.includes(eu)) throw new Error(`Size ${s.eu} for ${c.name} must be between 35 and 49 EU.`);
        const stock = clampNum(parseNum(s.stock, 0), 0, 9999);
        const criticalLevel = clampNum(parseNum(s.criticalLevel, getDefaultCriticalLevel()), 1, 999);
        return { eu, stock, criticalLevel, sku: '' };
      });
      const color = {
        id: c.id || uid('color'),
        name: c.name,
        code: c.code || '#ffffff',
        images,
        image: images.find(x => x) || '',
        sizes
      };
      color.sizes.forEach(s => { s.sku = generateSizeSKU(product, color, s.eu); });
      product.colors.push(color);
    });

    return product;
  }

  const firebaseState = { db: null, enabled: false };
  function firebaseAvailable() { return typeof window.firebase !== 'undefined' && window.firebase && window.firebase.apps !== undefined; }

  async function ensureAuth() {
    if (!firebaseAvailable() || !firebase.auth) return;
    return new Promise(resolve => {
      const unsub = firebase.auth().onAuthStateChanged(user => {
        if (unsub) unsub();
        if (user) { resolve(user); return; }
        if (window.ALLOW_ANON_SIGNIN === true) {
          firebase.auth().signInAnonymously().then(cred => resolve(cred.user)).catch(() => resolve());
        } else { resolve(); }
      });
    });
  }

  function initFirebase() {
    try {
      if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.projectId) return;
      if (!firebaseAvailable()) return;
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      firebaseState.db = firebase.firestore();
      firebaseState.enabled = true;
    } catch (e) { console.warn('Firebase init skipped', e); }
  }

  async function persistProduct(product) {
    if (!firebaseState.enabled || !firebaseState.db) {
      alert('Firebase is not available, so the product cannot be saved.');
      return;
    }
    await ensureAuth();
    const db = firebaseState.db;
    const pid = product.id || db.collection('products').doc().id;
    product.id = pid;
    // Validate inline images in product and colors before writing
    if (product.images && Array.isArray(product.images)) {
      for (const im of product.images) {
        if (im && im.indexOf && im.indexOf('data:') === 0) {
          if (!normalizeDataUri(im)) { alert('One or more product images are invalid. Please re-upload and try again.'); return; }
        }
      }
    }
    if (product.colors && Array.isArray(product.colors)) {
      for (const color of product.colors) {
        const imgs = Array.isArray(color.images) ? color.images : [];
        for (const im of imgs) {
          if (im && im.indexOf && im.indexOf('data:') === 0) {
            if (!normalizeDataUri(im)) { alert('One or more variant images are invalid. Please re-upload and try again.'); return; }
          }
        }
      }
    }
    await db.collection('products').doc(String(pid)).set(product, { merge: true });
    await Promise.all(product.colors.map(color => {
      const normalized = normalizeVariantImages(color.images);
      const vid = color.id || uid('color');
      const payload = {
        id: vid,
        productId: pid,
        colorName: color.name || '',
        colorCode: color.code || '',
        image: normalized.find(x => x) || '',
        images: normalized,
        sizes: Array.isArray(color.sizes) ? color.sizes.map(s => ({ eu: s.eu, stock: parseNum(s.stock, 0), criticalLevel: clampNum(parseNum(s.criticalLevel, getDefaultCriticalLevel()), 1, 999), sku: s.sku || '' })) : []
      };
      return db.collection('variants').doc(String(vid)).set(payload, { merge: true });
    }));
    alert('Product saved.');
    window.location.href = 'inventory.html';
  }

  function wireEvents() {
    const skuInputs = ['#prodBrand', '#prodModel', '#prodCategory'];
    skuInputs.forEach(sel => { const el = qs(sel); if (el) el.addEventListener('input', updateSkuPreview); });
    const qrBtn = qs('#prodGenerateQrBtn');
    if (qrBtn) qrBtn.addEventListener('click', () => {
      const arEl = qs('#prodARLink'); const preview = qs('#prodARQrPreview');
      const val = (arEl?.value || '').trim();
      if (!val) { alert('Enter an AR link first.'); return; }
      const url = qrImageUrlFor(val, 300);
      if (preview) { preview.src = url; preview.style.display = ''; }
    });
    const addColorBtn = qs('#addColorBtn'); if (addColorBtn) addColorBtn.addEventListener('click', (e) => { e.preventDefault(); addColor(); });
    const saveBtn = qs('#saveProductPageBtn'); if (saveBtn) saveBtn.addEventListener('click', async () => {
      try {
        const product = gatherProduct();
        await persistProduct(product);
      } catch (e) {
        alert(e.message || 'Failed to save product.');
      }
    });
  }

  function init() {
    initFirebase();
    updateSkuPreview();
    wireEvents();
    renderColors();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
