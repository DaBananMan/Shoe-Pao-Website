// Footwear Inventory Manager
// Data model and client-side storage
(function() {
  const EU_SIZES = Array.from({ length: 15 }, (_, i) => 35 + i); // 35..49
  const defaultSettings = { lowStockThreshold: 3 };

  const state = {
    products: [],
    sales: [],
    settings: { ...defaultSettings },
    ui: {
      selectedTab: 'inventory',
      bulkMode: false,
      selectedProductIds: new Set(),
      editingProductId: null,
      editingVariantProductId: null,
      editingVariantColorId: null,
      productModalColors: [],
      productModalImages: [],
      reports: { timeframe: 'all', open: { low: false, sizes: false, brands: false, dead: false } }
    }
  };

  // Cache of products as rendered in the table to ensure modals reflect the visible row
  let displayedProductCache = {};

  // Utilities
  const uid = (p='id') => `${p}-${Math.random().toString(36).slice(2, 9)}`;
  const clampNum = (n, min, max) => Math.max(min, Math.min(max, n));
  const parseNum = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  function normalizeVariantImages(images, fallback) {
    let list = Array.isArray(images) ? images.slice() : [];
    if ((!list.length || !list.some(x => x && String(x).trim())) && fallback) {
      list = [fallback];
    }
    list = list.map(x => String(x || '').trim()).filter(Boolean);
    if (list.length > 4) list = list.slice(0, 4);
    while (list.length < 4) list.push('');
    return list;
  }

  function applyColorImages(color) {
    if (!color) return [];
    const normalized = normalizeVariantImages(color.images, color.image);
    color.images = normalized;
    color.image = normalized.find(x => x && String(x).trim()) || '';
    return normalized;
  }

  function countColorImages(color) {
    const imgs = Array.isArray(color && color.images) ? color.images : [];
    return imgs.filter(x => x && String(x).trim()).length;
  }

  // Effective threshold for 'low stock' per product: per-product `criticalLevel` overrides
  // global settings.lowStockThreshold when present and valid.
  function effectiveThresholdForProduct(p) {
    try {
      const cand = (p && (p.criticalLevel || p.critical_level || p.critical));
      const n = parseNum(cand, NaN);
      if (Number.isFinite(n) && n >= 1) return clampNum(Math.floor(n), 1, 999);
    } catch (e) {}
    return state.settings && state.settings.lowStockThreshold ? state.settings.lowStockThreshold : 3;
  }

  // SKU generation: SP-BBB-MMMM-XXXX
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
    const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
    let base = `${prefix}-${b}-${m}-${rand}`;
    // Ensure uniqueness if state is available
    if (state && Array.isArray(state.products)) {
      if (!state.products.some(p => p.sku === base)) return base;
      let i = 1; let sku = `${base}-${i}`;
      while (state.products.some(p => p.sku === sku)) { i++; sku = `${base}-${i}`; }
      return sku;
    }
    return base;
  }

  // Size-level SKU generation: <productSku>-CCCC-S##
  function generateSizeSKU(product, color, eu) {
    const clean = (str, len) => {
      let s = String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!s) s = 'X'.repeat(len);
      return s.slice(0, len);
    };
    const base = (product && product.sku) ? String(product.sku).trim() : generateProductSKU(product && product.brand, product && product.model, product && product.category);
    const colorToken = clean((color && (color.code || color.name || color.id)) || '', 4);
    const sizeToken = String(eu || '').replace(/[^0-9]/g, '');
    const sizePart = sizeToken ? `S${sizeToken}` : 'SXX';
    return `${base}-${colorToken}-${sizePart}`;
  }

  function ensureSizeSkusForProduct(p) {
    let changed = false;
    if (!p) return false;
    if (!p.sku || !String(p.sku).trim()) {
      p.sku = generateProductSKU(p.brand, p.model, p.category);
      changed = true;
    }
    if (!Array.isArray(p.colors)) return changed;
    p.colors.forEach(c => {
      if (!Array.isArray(c.sizes)) return;
      c.sizes.forEach(s => {
        if (!s) return;
        if (!s.sku || !String(s.sku).trim()) {
          s.sku = generateSizeSKU(p, c, s.eu);
          changed = true;
        }
      });
    });
    return changed;
  }

  function displayNameFromUrl(url) {
    try {
      if (!url) return 'image';
      if (url.startsWith('data:')) {
        const mime = url.slice(5).split(';')[0];
        const ext = (mime.split('/')[1] || 'img').toLowerCase();
        return `image.${ext}`;
      }
      const u = new URL(url, window.location.origin);
      const seg = u.pathname.split('/').filter(Boolean);
      return seg.length ? seg[seg.length - 1] : url;
    } catch {
      return 'image';
    }
  }

  // Generate a stable QR image URL for a given data string using goqr.me / qrserver
  function qrImageUrlFor(data, size) {
    try {
      if (!data) return '';
      var s = size && Number.isFinite(Number(size)) ? Number(size) : 300;
      return 'https://api.qrserver.com/v1/create-qr-code/?size=' + encodeURIComponent(s + 'x' + s) + '&data=' + encodeURIComponent(String(data));
    } catch (e) { return ''; }
  }

  // --- Firebase / Firestore helpers (optional): if window.FIREBASE_CONFIG is provided,
  // initialize Firebase and subscribe to live updates. All calls are guarded so the
  // app continues to work offline/local-only when no config is present.
  const firebaseState = { db: null, enabled: false };

  // (debug panel removed) 

  function firebaseAvailable() {
    return typeof window.firebase !== 'undefined' && window.firebase && window.firebase.apps !== undefined;
  }

  function initFirebase() {
    try {
      if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.projectId) return;
      if (!firebaseAvailable()) {
        console.warn('Firebase scripts not loaded; skip Firebase init');
        return;
      }
      // Avoid double-init
      if (firebase.apps && firebase.apps.length) {
        // reuse existing
      } else {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      firebaseState.db = firebase.firestore();
      firebaseState.enabled = true;
      // Enable persistence where supported
      // Prefer cache-based settings in future SDKs; keep enablePersistence for now
      if (firebaseState.db.enablePersistence) {
        firebaseState.db.enablePersistence().catch(function(err){
          // ignore persistence errors (multiple tabs or unsupported)
          console.warn('Firestore persistence not enabled:', err && err.message);
        });
      }

      // Ensure user is signed-in before attaching listeners. Many Firestore rules
      // restrict reads to authenticated users. We'll attempt anonymous sign-in for
      // a friction-free dev experience; if your rules disallow anonymous access
      // you'll still see permission-denied errors and should update rules or sign
      // in with a proper credential.
      if (firebase.auth) {
        firebase.auth().onAuthStateChanged(user => {
          if (user) {
            console.info('Firebase auth state:', user && (user.uid || user.isAnonymous ? 'signed-in' : 'no-user'));
            attachFirestoreListeners();
          } else {
            // Anonymous sign-in used to be automatic for developer convenience.
            // To avoid creating accidental anonymous accounts during flows like signup
            // (where a user may later create an email account), require an explicit opt-in
            // by setting `window.ALLOW_ANON_SIGNIN = true` on the page. If not set, skip.
            if (window.ALLOW_ANON_SIGNIN === true) {
              // try anonymous sign-in for development convenience
              firebase.auth().signInAnonymously().then(cred => {
                console.info('Signed in anonymously as', cred && cred.user && cred.user.uid);
                attachFirestoreListeners();
              }).catch(err => {
                console.warn('Anonymous sign-in failed (rules may disallow). Continuing without auth:', err && err.message);
                // Still attempt to attach listeners; they'll error if rules block reads.
                attachFirestoreListeners();
              });
            } else {
              console.info('Anonymous sign-in disabled (set window.ALLOW_ANON_SIGNIN = true to enable)');
              attachFirestoreListeners();
            }
          }
        });
      } else {
        // No auth available; attach listeners anyway (may receive permission errors).
        attachFirestoreListeners();
      }

      console.info('Firebase initialized (auth pending)');
    } catch (e) {
      console.error('initFirebase error', e);
    }
  }

  // Attach Firestore listeners in one place so we can call it after auth is ready
  function attachFirestoreListeners() {
    if (!firebaseState.enabled || !firebaseState.db) return;

    // products
    firebaseState.db.collection('products').onSnapshot(snapshot => {
      try {
          let docs = snapshot.docs.map(d => Object.assign({ id: d.id }, d.data()));
              // Do not merge or read localStorage here. Prefer Firestore as the source-of-truth
              // to avoid showing stale local values that get overwritten on snapshot arrival.
          // Normalize common field name variants and ensure `pricing`, `category`, `status`, and `tagsManual`
          // exist so the UI shows the expected columns even when Firestore uses different keys.
          docs = docs.map(d => {
            try {
              const out = Object.assign({}, d);
              // category fallbacks
              out.category = out.category || out.categoryName || out.cat || out.category_id || out.categoryCode || '';
              // status fallbacks
              out.status = out.status || out.state || out.availability || '';
              // tags fallbacks
              out.tagsManual = Array.isArray(out.tagsManual) ? out.tagsManual : (Array.isArray(out.tags) ? out.tags : (out.tagsList || out.tags_list || []));
              if (!Array.isArray(out.tagsManual)) out.tagsManual = [];
              // Pricing normalization: prefer nested `pricing`, otherwise detect common top-level price fields
              const p = out.pricing || {};
              const origCandidates = [p.original, p.orig, out.originalPrice, out.original_price, out.priceOriginal, out.price_original, out.price];
              const saleCandidates = [p.sale, p.salePrice, p.sale_price, out.salePrice, out.sale_price, out.price_sale];
              const costCandidates = [0];
              const pickNum = arr => {
                for (const v of arr) {
                  if (v === undefined || v === null) continue;
                  const n = Number(v);
                  if (Number.isFinite(n)) return n;
                }
                return 0;
              };
              out.pricing = {
                original: pickNum(origCandidates),
                sale: pickNum(saleCandidates) || pickNum(origCandidates),
                cost: pickNum(costCandidates)
              };
              // Ensure images array
              out.images = Array.isArray(out.images) ? out.images : (out.image ? [out.image] : []);
              return out;
            } catch (e) { return d; }
          });
          state.products = docs;
  // Merge any known variants into products shape and render (do not persist to localStorage)
  mergeVariantsIntoProducts();
          backfillSizeSkus();
  renderAll();
  // (debug panel removed) 
      } catch (e) { console.error('Error applying products snapshot', e); }
    }, err => {
      console.error('products snapshot error:', err);
      if (err && err.code === 'permission-denied') {
        console.error('Firestore permission-denied when listening to products. Check your Firestore security rules and ensure the client is authenticated or rules allow read access for this path.');
      }
    });

    // sales
    firebaseState.db.collection('sales').onSnapshot(snapshot => {
      try {
        const docs = snapshot.docs.map(d => Object.assign({ id: d.id }, d.data()));
    state.sales = docs;
  renderAll();
      } catch (e) { console.error('Error applying sales snapshot', e); }
    }, err => {
      console.error('sales snapshot error:', err);
      if (err && err.code === 'permission-denied') {
        console.error('Firestore permission-denied when listening to sales. Check your Firestore security rules and ensure the client is authenticated or rules allow read access for this path.');
      }
    });

    // variants: keep a local grouped map and merge into products view
    // variantsByProductId: { [productId]: [ colorObj, ... ] }
    firebaseState.variantsByProductId = {};
    firebaseState.db.collection('variants').onSnapshot(snapshot => {
      try {
        const docs = snapshot.docs.map(d => Object.assign({ id: d.id }, d.data()));
        // rebuild grouped map
        const map = {};
        docs.forEach(v => {
          // try common field names for parent product id or DocumentReference shapes
          const pid = v.productId || v.product_id || (v.product && (v.product.id || v.productId)) || (v.productRef && v.productRef.id) || (v.product_ref && v.product_ref.id) || (v.product && typeof v.product === 'string' ? (v.product.split('/').pop()) : null) || (v.productPath && typeof v.productPath === 'string' ? v.productPath.split('/').pop() : null) || null;
          if (!pid) return;
          map[pid] = map[pid] || [];
          // normalize a variant doc into a color object the UI expects
          const normalizedImages = normalizeVariantImages(v.images || [], v.image || '');
          const color = {
            id: v.id || uid('color'),
            name: v.colorName || v.name || v.color || 'Color',
            code: v.colorCode || v.code || '#ffffff',
            images: normalizedImages,
            image: normalizedImages.find(x => x && String(x).trim()) || '',
            sizes: []
          };
          // variant may store sizes as array of { eu, stock } or as an object map
          if (Array.isArray(v.sizes)) {
            // ensure sizes have eu and stock
            color.sizes = EU_SIZES.map(eu => {
              const found = v.sizes.find(s => Number(s.eu) === Number(eu) || String(s.eu) === String(eu));
              return { eu, stock: found ? parseNum(found.stock, 0) : 0, sku: found && found.sku || '' };
            });
          } else if (v.sizeMap && typeof v.sizeMap === 'object') {
            color.sizes = EU_SIZES.map(eu => ({ eu, stock: parseNum(v.sizeMap[String(eu)] || v.sizeMap[eu] || 0, 0), sku: '' }));
          } else if (v.sizesMap && typeof v.sizesMap === 'object') {
            color.sizes = EU_SIZES.map(eu => ({ eu, stock: parseNum(v.sizesMap[String(eu)] || 0, 0), sku: '' }));
          } else {
            // fallback: try numeric fields like stock35, stock36, etc.
            color.sizes = EU_SIZES.map(eu => ({ eu, stock: parseNum(v[`s${eu}`] || v[`stock${eu}`] || 0, 0), sku: '' }));
          }
          map[pid].push(color);
        });
    firebaseState.variantsByProductId = map;
    // merge into products and re-render (do not persist to localStorage)
    mergeVariantsIntoProducts();
  backfillSizeSkus();
  renderAll();
      } catch (e) { console.error('Error applying variants snapshot', e); }
    }, err => {
      console.error('variants snapshot error:', err);
      if (err && err.code === 'permission-denied') {
        console.error('Firestore permission-denied when listening to variants. Check your Firestore security rules and ensure the client is authenticated or rules allow read access for this path.');
      }
    });

  }

  // Merge variants (from firebaseState.variantsByProductId) into state.products.
  // Strategy: for each product, if it already has a non-empty colors array, keep it
  // (but optionally merge); otherwise, if variants exist for that productId, use them.
  function mergeVariantsIntoProducts() {
    if (!Array.isArray(state.products)) return;
    const map = firebaseState.variantsByProductId || {};
    state.products = state.products.map(p => {
      const pid = p.id || p.productId || p.sku || null;
      const hasColors = Array.isArray(p.colors) && p.colors.length;
      if (pid && map[pid]) {
        if (hasColors) {
          const np = Object.assign({}, p);
          np.colors = (p.colors || []).map(c => {
            const match = map[pid].find(v => v.id === c.id || (v.name && c.name && String(v.name).toLowerCase() === String(c.name).toLowerCase()));
            if (!match) return c;
            const merged = Object.assign({}, c);
            if (!Array.isArray(merged.images) || merged.images.length === 0) merged.images = match.images || [];
            if (!merged.image) merged.image = (match.images && match.images.find(x => x && String(x).trim())) || match.image || '';
            if (!merged.code) merged.code = match.code || merged.code;
            if (!merged.name) merged.name = match.name || merged.name;
            if (!Array.isArray(merged.sizes) || merged.sizes.length === 0) merged.sizes = match.sizes || [];
            return merged;
          });
          return np;
        }
        // clone product and attach colors from variants
        const np = Object.assign({}, p);
        np.colors = map[pid].map(c => ({ id: c.id, name: c.name, code: c.code, sizes: c.sizes, images: c.images || [], image: c.image || '' }));
        return np;
      }
      return p;
    });
  }

  function upsertProductToFirestore(product) {
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    const id = product.id || product.sku || firebaseState.db.collection('products').doc().id;
    // Avoid circular references and functions — Firestore accepts plain objects
    const safe = Object.assign({}, product);
    safe.pricing = safe.pricing || {};
    safe.pricing.original = parseNum(safe.pricing.original, 0);
    safe.pricing.sale = parseNum(safe.pricing.sale, safe.pricing.original || 0);
    safe.pricing.cost = 0;
    safe.tagsManual = Array.isArray(safe.tagsManual) ? safe.tagsManual : (Array.isArray(safe.tags) ? safe.tags : []);
    safe.category = safe.category || '';
    safe.status = safe.status || '';
    // Sanitize payload to avoid sending large data URIs or huge arrays (images replaced with lightweight pathfile markers)
    const sanitized = sanitizeProductForFirestore(safe);
    const payload = JSON.parse(JSON.stringify(sanitized));
    return firebaseState.db.collection('products').doc(String(id)).set(payload, { merge: true })
      .then(() => console.info('upsertProductToFirestore: written product', String(id)))
      .catch(err => console.error('upsertProductToFirestore', err));
  }

  function deleteProductFromFirestore(id) {
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    return firebaseState.db.collection('products').doc(String(id)).delete()
      .then(() => console.info('deleteProductFromFirestore: deleted product', String(id)))
      .catch(err => console.error('deleteProductFromFirestore', err));
  }

  function upsertSaleToFirestore(sale) {
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    const id = sale.id || firebaseState.db.collection('sales').doc().id;
    const payload = JSON.parse(JSON.stringify(sale));
    return firebaseState.db.collection('sales').doc(String(id)).set(payload, { merge: true })
      .then(() => console.info('upsertSaleToFirestore: written sale', String(id)))
      .catch(err => console.error('upsertSaleToFirestore', err));
  }

  // Variants write helpers: create/update/delete variant documents in `variants` collection
  function upsertVariantToFirestore(productId, color) {
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    const id = color.id || firebaseState.db.collection('variants').doc().id;
    const normalizedImages = normalizeVariantImages(color.images || [], color.image || '');
    const payload = {
      id: id,
      productId: productId,
      colorName: color.name || '',
      colorCode: color.code || '',
      image: normalizedImages.find(x => x && String(x).trim()) || '',
      images: normalizedImages,
      // store sizes as an array of { eu, stock, sku }
      sizes: Array.isArray(color.sizes) ? color.sizes.map(s => ({ eu: s.eu, stock: parseNum(s.stock, 0), sku: s.sku || '' })) : []
    };
    return firebaseState.db.collection('variants').doc(String(id)).set(payload, { merge: true })
      .then(() => console.info('upsertVariantToFirestore: written variant', String(id), 'for product', String(productId)))
      .catch(err => console.error('upsertVariantToFirestore', err));
  }

  function deleteVariantFromFirestore(id) {
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    return firebaseState.db.collection('variants').doc(String(id)).delete()
      .then(() => console.info('deleteVariantFromFirestore: deleted variant', String(id)))
      .catch(err => console.error('deleteVariantFromFirestore', err));
  }

  // Sync local product.colors with Firestore variants collection for that product
  function syncVariantsForProduct(product) {
    if (!product || !product.id) return Promise.resolve();
    if (!firebaseState.enabled || !firebaseState.db) return Promise.resolve();
    const pid = product.id;
    const existing = firebaseState.variantsByProductId && firebaseState.variantsByProductId[pid] ? firebaseState.variantsByProductId[pid].map(v => v.id).filter(Boolean) : [];
    const desired = Array.isArray(product.colors) ? product.colors.map(c => c.id).filter(Boolean) : [];
    const upserts = (product.colors || []).map(c => upsertVariantToFirestore(pid, c));
    // delete variants that exist remotely but were removed locally
    const toDelete = existing.filter(id => !desired.includes(id));
    const deletes = toDelete.map(id => deleteVariantFromFirestore(id));
    return Promise.all([Promise.all(upserts), Promise.all(deletes)]).catch(err => console.error('syncVariantsForProduct', err));
  }

  // Schedule & perform a full one-way sync from local `state.products` to Firestore so the
  // remote DB mirrors the current admin UI. This is intentionally aggressive: it will upsert
  // local products/variants and delete remote docs that no longer exist locally. Use only for
  // dev or when the UI should be the source-of-truth.
  function scheduleFullSync(delay = 1000) {
    if (!firebaseState.enabled || !firebaseState.db) return;
    if (firebaseState.syncTimer) clearTimeout(firebaseState.syncTimer);
    firebaseState.syncTimer = setTimeout(() => { fullSyncToFirestore().catch(err => console.error('fullSyncToFirestore', err)); }, delay);
  }

  async function fullSyncToFirestore() {
    if (!firebaseState.enabled || !firebaseState.db) return;
    try {
      const db = firebaseState.db;
      // read remote collections (one-time)
      const [remoteProductsSnap, remoteVariantsSnap] = await Promise.all([
        db.collection('products').get(),
        db.collection('variants').get()
      ]);

      const remoteProducts = new Map(remoteProductsSnap.docs.map(d => [String(d.id), d]));
      const remoteVariants = new Map(remoteVariantsSnap.docs.map(d => [String(d.id), d]));

      // Build local maps
      const localProducts = (Array.isArray(state.products) ? state.products : []).map(p => {
        // ensure id
        const id = p.id || p.sku || uid('prod');
        const copy = JSON.parse(JSON.stringify(Object.assign({}, p)));
        copy.id = id;
        copy.pricing = copy.pricing || { original: 0, sale: 0, cost: 0 };
        return copy;
      });
      const localProductIds = new Set(localProducts.map(p => String(p.id)));

      // Prepare operations: upsert local products (set), delete remote products not in local
      const ops = [];
      localProducts.forEach(p => {
        const docRef = db.collection('products').doc(String(p.id));
        // Sanitize product to avoid sending data URIs or oversized arrays
        const sanitized = sanitizeProductForFirestore(p);
        // write the sanitized product document to reflect UI (overwrite)
        ops.push({ type: 'set', ref: docRef, payload: sanitized });
      });
      remoteProducts.forEach((d, id) => {
        if (!localProductIds.has(id)) ops.push({ type: 'delete', ref: db.collection('products').doc(id) });
      });

      // Variants: local aggregate
      const localVariantsMap = new Map(); // variantId -> payload
      localProducts.forEach(p => {
        const pid = String(p.id);
        (Array.isArray(p.colors) ? p.colors : []).forEach(c => {
          const vid = c.id || `${pid}-${c.name || c.code || uid('color')}`;
          const normalizedImages = normalizeVariantImages(c.images || [], c.image || '');
          const payload = {
            id: vid,
            productId: pid,
            colorName: c.name || '',
            colorCode: c.code || '',
            image: normalizedImages.find(x => x && String(x).trim()) || '',
            images: normalizedImages,
            sizes: Array.isArray(c.sizes) ? c.sizes.map(s => ({ eu: s.eu, stock: parseNum(s.stock,0), sku: s.sku || '' })) : []
          };
          localVariantsMap.set(String(vid), payload);
        });
      });

      // Upsert local variants
      localVariantsMap.forEach((payload, id) => {
        const ref = db.collection('variants').doc(String(id));
        ops.push({ type: 'set', ref, payload });
      });
      // Delete remote variants not in local map
      remoteVariants.forEach((d, id) => { if (!localVariantsMap.has(String(id))) ops.push({ type: 'delete', ref: db.collection('variants').doc(String(id)) }); });

      // Commit operations in batches (max 400 per batch to be safe)
      const chunkSize = 400;
      for (let i = 0; i < ops.length; i += chunkSize) {
        const chunk = ops.slice(i, i + chunkSize);
        const batch = db.batch();
        chunk.forEach(op => {
          if (op.type === 'set') batch.set(op.ref, op.payload);
          else if (op.type === 'delete') batch.delete(op.ref);
        });
        await batch.commit();
      }

      console.info('fullSyncToFirestore: sync completed (products:', localProducts.length, 'variants:', localVariantsMap.size, ')');
      return true;
    } catch (e) {
      console.error('fullSyncToFirestore failed', e);
      throw e;
    }
  }

  // Merge-only sync: upsert local products and variants to Firestore without deleting remote docs.
  // This is the safe option to populate category/status fields in Firestore without destructive deletes.
  async function mergeOnlySyncToFirestore() {
    if (!firebaseState.enabled || !firebaseState.db) {
      console.warn('mergeOnlySyncToFirestore: Firebase not initialized or disabled; no-op');
      return Promise.resolve();
    }
    try {
      const db = firebaseState.db;
      console.info('mergeOnlySyncToFirestore: starting upserts for', (Array.isArray(state.products) ? state.products.length : 0), 'products');
      for (const p of (Array.isArray(state.products) ? state.products : [])) {
        try {
          // Ensure product has id
          p.id = p.id || p.sku || db.collection('products').doc().id;
          await upsertProductToFirestore(p);
        } catch (e) {
          console.error('mergeOnlySyncToFirestore: failed upsert product', p && (p.id || p.sku), e);
        }
        try {
          await syncVariantsForProduct(p);
        } catch (e) {
          console.error('mergeOnlySyncToFirestore: failed syncing variants for', p && (p.id || p.sku), e);
        }
      }
      console.info('mergeOnlySyncToFirestore: completed');
      return true;
    } catch (e) {
      console.error('mergeOnlySyncToFirestore: unexpected error', e);
      throw e;
    }
  }

  // Expose the merge-only sync for manual invocation from the browser console:
  // in the page console run: window.mergeOnlySyncToFirestore()
  try { window.mergeOnlySyncToFirestore = mergeOnlySyncToFirestore; } catch (e) { /* ignore in non-browser test runners */ }

  // Data helpers
  function ensureSizes() {
    return EU_SIZES.map(eu => ({ eu, stock: 0, sku: '' }));
  }

  // Sanitize product payload to avoid sending large embedded blobs (data URIs) and very large arrays.
  // - Replaces data: URI images with a lightweight { pathfile: '<placeholder>' } entry
  // - Limits images array length to a reasonable cap
  // - Truncates overly long string fields if necessary
  function sanitizeProductForFirestore(p) {
    if (!p || typeof p !== 'object') return p;
    // shallow copy then process
    const out = Object.assign({}, p);
    try {
      // Images: map data URIs to pathfile placeholders; keep normal URLs/paths
      if (Array.isArray(out.images)) {
        const cap = 20; // keep at most 20 images
        const images = out.images.slice(0, cap).map((img, idx) => {
          if (typeof img === 'string' && img.startsWith('data:')) {
            // Try to infer a filename from alt props if available, else put a placeholder
            const inferred = (out.imagePaths && out.imagePaths[idx]) || (out.imagePath) || '[DATA_URI_REMOVED]';
            return { pathfile: inferred };
          }
          // keep short strings as-is; if it's an object, leave it but avoid large nested blobs
          if (typeof img === 'string') return img;
          try { return JSON.parse(JSON.stringify(img)); } catch { return '[IMAGE_REDACTED]'; }
        });
        out.images = images;
      }

      // Safety: truncate very large arrays that may have been used for logs/history
      if (Array.isArray(out.tagsManual) && out.tagsManual.length > 500) out.tagsManual = out.tagsManual.slice(0, 500);

      // Truncate extremely long strings on top-level fields
      const maxStr = 200000; // 200 KB per-field defensive cap
      Object.keys(out).forEach(k => {
        if (typeof out[k] === 'string' && out[k].length > maxStr) {
          out[k] = out[k].slice(0, maxStr) + '...[TRUNCATED]';
        }
      });
    } catch (e) {
      // On any sanitizer failure, return a minimal safe shape
      return { id: out.id || out.sku || uid('prod'), brand: out.brand || '', model: out.model || '', sku: out.sku || '' };
    }
    return out;
  }

  function newColor(name, code) {
    return { id: uid('color'), name, code: code || '#ffffff', sizes: ensureSizes(), images: normalizeVariantImages([], '') };
  }

  function newProduct({ brand, model, category, status = 'active', images = [], pricing = {}, description = '', sku = '', gender = 'Unisex' }) {
    return {
      id: uid('prod'), brand, model, category, status,
      gender: gender || 'Unisex',
      images, pricing: {
        original: parseNum(pricing.original, 0),
        sale: parseNum(pricing.sale, 0),
        cost: 0
      },
      description,
      sku: sku || generateProductSKU(brand, model, category),
      colors: [],
      tagsManual: [],
      createdAt: new Date().toISOString()
    };
  }

  function totalStockForProduct(p) {
    if (!p) return 0;
    // If product has colors array, sum each color
    if (Array.isArray(p.colors) && p.colors.length) {
      return p.colors.reduce((acc, c) => acc + totalStockForColor(c), 0);
    }
    // If product stores sizes as an object map at product level (e.g. {"42":3, "43":0}), sum those
    if (p.sizes && typeof p.sizes === 'object' && !Array.isArray(p.sizes)) {
      return Object.keys(p.sizes).reduce((acc, k) => acc + (parseNum(p.sizes[k], 0) || 0), 0);
    }
    // Fallback to common numeric fields
    return parseNum(p.qty, parseNum(p.stock, parseNum(p.inventory, parseNum(p.total, 0))));
  }

  function totalStockForColor(c) {
    if (!c) return 0;
    // If sizes stored as array of {eu, stock}
    if (Array.isArray(c.sizes) && c.sizes.length) return c.sizes.reduce((acc, s) => acc + (parseNum(s.stock,0) || 0), 0);
    // If sizes stored as an object map { '42': 3, '43': 0 }
    if (c.sizes && typeof c.sizes === 'object') return Object.keys(c.sizes).reduce((acc, k) => acc + (parseNum(c.sizes[k],0) || 0), 0);
    // Fallback numeric fields on color/variant
    return parseNum(c.qty, parseNum(c.stock, parseNum(c.inventory, 0)));
  }

  // Convert a size map/object into an array of { eu, stock } entries for uniform processing
  function sizesObjectToArray(sizesObj) {
    if (!sizesObj || typeof sizesObj !== 'object') return [];
    return Object.keys(sizesObj).map(k => ({ eu: Number(k) || k, stock: parseNum(sizesObj[k], 0) }));
  }

  function availableSizes(c) {
    if (!c || !Array.isArray(c.sizes)) return [];
    return c.sizes.filter(s => parseNum(s.stock,0) > 0).map(s => s.eu);
  }

  // Persistence
  function loadAll() {
    state.products = [];
    state.sales = [];
    state.settings = { ...defaultSettings };
  }

  function saveAll() {
    // Schedule a one-way sync to Firestore so remote mirrors current UI state
    try { if (firebaseState && firebaseState.enabled) scheduleFullSync(); } catch (e) { /* ignore */ }
  }

  // Ensure every product has a SKU; generate if missing/blank
  function backfillSkus() {
    if (!Array.isArray(state.products) || !state.products.length) return;
    let changed = false;
    state.products.forEach(p => {
      if (!p.sku || !String(p.sku).trim()) {
        p.sku = generateProductSKU(p.brand, p.model, p.category);
        changed = true;
      }
    });
    if (changed) saveAll();
  }

  // Ensure every size has a SKU; generate if missing/blank
  function backfillSizeSkus() {
    if (!Array.isArray(state.products) || !state.products.length) return;
    let changed = false;
    state.products.forEach(p => { if (ensureSizeSkusForProduct(p)) changed = true; });
    if (changed) saveAll();
  }

  // Ensure createdAt exists for legacy products
  function backfillCreatedAt() {
    if (!Array.isArray(state.products) || !state.products.length) return;
    let changed = false;
    state.products.forEach(p => {
      if (!p.createdAt) { p.createdAt = new Date().toISOString(); changed = true; }
    });
    if (changed) saveAll();
  }

  // Backfill category and status for products. Try to infer category from model/brand
  // using a small keyword map; otherwise default to 'Uncategorized'. Ensure status is 'active'.
  function backfillCategoryAndStatus() {
    if (!Array.isArray(state.products) || !state.products.length) return;
    const changedProducts = [];
    const keywordMap = [
      { keys: ['air','max','airmax','nike'], cat: 'Sneakers' },
      { keys: ['ultra','boost','adidas','running'], cat: 'Running' },
      { keys: ['moccasin','moccasins','loafer'], cat: 'Casual' },
      { keys: ['sandal','sandals','flip'], cat: 'Sandals' },
      { keys: ['boot','boots'], cat: 'Boots' },
      { keys: ['slip','slide'], cat: 'Casual' },
      { keys: ['sneaker','sneakers'], cat: 'Sneakers' },
      { keys: ['formal','dress'], cat: 'Formal' }
    ];

    const infer = (p) => {
      const txt = ((p.model || '') + ' ' + (p.brand || '') + ' ' + (p.category || '')).toLowerCase();
      for (const entry of keywordMap) {
        for (const k of entry.keys) if (txt.indexOf(k) !== -1) return entry.cat;
      }
      return p.category || 'Uncategorized';
    };

    let changed = false;
    state.products.forEach(p => {
      const cat = infer(p);
      if (!p.category || p.category !== cat) { p.category = cat; changed = true; }
      if (!p.status || p.status !== 'active') { p.status = 'active'; changed = true; }
      // ensure pricing object exists so UI shows price
      p.pricing = p.pricing || { original: 0, sale: 0, cost: 0 };
      if (!Array.isArray(p.tagsManual)) p.tagsManual = [];
      if (changed) changedProducts.push(p.id || p.sku || '(new)');
    });
    if (changed) {
      saveAll();
      console.info('backfillCategoryAndStatus: updated products', changedProducts.slice(0,20));
    }
  }

  // Sample data removed — seeding disabled

  // UI binding helpers
  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  function switchTab(tab) {
    state.ui.selectedTab = tab;
    qsa('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    qsa('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    renderAll();
  }

  function populateFilters() {
    const brands = Array.from(new Set(state.products.map(p => p.brand))).sort();
    const categories = Array.from(new Set(state.products.map(p => p.category))).sort();
    const brandSel = qs('#filterBrand');
    const catSel = qs('#filterCategory');
    brandSel.innerHTML = '<option value="">All Brands</option>' + brands.map(b => `<option>${b}</option>`).join('');
    catSel.innerHTML = '<option value="">All Categories</option>' + categories.map(c => `<option>${c}</option>`).join('');

    const sizeSel = qs('#filterSize');
    sizeSel.innerHTML = '<option value="">Any Size</option>' + EU_SIZES.map(s => `<option value="${s}">${s}EU</option>`).join('');
  }

  // Inventory listing
  function renderProductsTable() {
    const tbody = qs('#productsTbody');
    const text = qs('#searchInput').value.toLowerCase();
    const filterBrand = qs('#filterBrand').value;
    const filterCat = qs('#filterCategory').value;
    const filterSize = qs('#filterSize').value;
    const filterStock = qs('#filterStock').value; // '', 'low', 'out', 'in'
    const filterStatus = qs('#filterStatus') ? qs('#filterStatus').value : '';
  // Per-product effective threshold will be used in filtering; keep a local var for default
  const threshold = state.settings.lowStockThreshold;

  // Use a guarded products array in case Firestore or imports yielded products without a
  // `colors` array (e.g. when variants are stored separately or permission-denied prevents
  // the variants merge). This prevents repeated `Cannot read properties of undefined` errors.
  const productsList = Array.isArray(state.products) ? state.products : [];
  // Build a per-render cache so modals open with the exact values visible in the table row
  displayedProductCache = {};

  // Compute best-seller products (all-time, by units)
  const byProductQty = new Map();
  (Array.isArray(state.sales) ? state.sales : []).forEach(s => byProductQty.set(s.productId, (byProductQty.get(s.productId) || 0) + s.qty));
    const bestIds = new Set(Array.from(byProductQty.entries()).sort((a,b) => b[1]-a[1]).slice(0,5).map(([id]) => id));

    function computeTags(p) {
      const tags = [];
      const now = Date.now();
      const created = p.createdAt ? new Date(p.createdAt).getTime() : 0;
      const ageDays = created ? Math.floor((now - created) / (24*3600*1000)) : Infinity;
      const isNew = ageDays <= 14 && p.status === 'active';
  const isSale = (parseNum(p.pricing?.sale,0) > 0) && (parseNum(p.pricing?.sale,0) < parseNum(p.pricing?.original,0)) && p.status === 'active';
      const total = totalStockForProduct(p);
      const isPre = (total === 0) && p.status === 'active';
      const isBest = bestIds.has(p.id);
      const hasAr = !!(p.arLink || p.ar_link || p.arUrl || p.ar_url);
      if (isNew) tags.push('New');
      if (isSale) tags.push('Sale');
      if (isPre) tags.push('Pre-Order');
      if (isBest) tags.push('Best Seller');
      if (hasAr) tags.push('Try On!');
      const manual = Array.isArray(p.tagsManual) ? p.tagsManual : [];
      // Merge manual and auto tags, deduped
      return Array.from(new Set([ ...manual, ...tags ]));
    }

    const filtered = productsList.filter(p => {
      // Build a colors array that includes merged variants if the product
      // doesn't include a `colors` array directly (variants may be stored
      // separately in firebaseState.variantsByProductId).
      let colorsArr = Array.isArray(p.colors) ? p.colors : [];
      if ((!colorsArr || colorsArr.length === 0) && firebaseState.variantsByProductId) {
        const map = firebaseState.variantsByProductId;
        const candidates = [p.id, p.productId, p.sku, String(p.id || '')];
        for (const c of candidates) {
          if (!c) continue;
          if (Array.isArray(map[c]) && map[c].length) { colorsArr = map[c]; break; }
        }
      }
      // If still no colors but product-level sizes exist as an object map, synthesize
      // a single color entry so filters and totals work (handles legacy shapes).
      if ((!colorsArr || colorsArr.length === 0) && p.sizes && typeof p.sizes === 'object') {
        colorsArr = [{ id: p.id + '-default', name: p.title || p.name || p.model || 'Default', sizes: sizesObjectToArray(p.sizes) }];
      }
      const matchesText = !text || [p.brand, p.model, p.category].join(' ').toLowerCase().includes(text) || colorsArr.some(c => (c.name || '').toLowerCase().includes(text));
      const matchesBrand = !filterBrand || p.brand === filterBrand;
      const matchesCat = !filterCat || p.category === filterCat;
      // If a specific size is selected, consider size existence; allow out-of-stock when filtering 'out'
      const matchesSize = !filterSize || colorsArr.some(c => {
        if (Array.isArray(c.sizes)) return c.sizes.some(s => String(s.eu) === filterSize && (filterStock === 'out' ? true : (parseNum(s.stock,0) > 0)));
        if (c.sizes && typeof c.sizes === 'object') {
          var q = parseNum(c.sizes[String(filterSize)] || c.sizes[filterSize] || 0, 0);
          return filterStock === 'out' ? true : q > 0;
        }
        return false;
      });
      // Determine stock status: use total product stock, or size-specific total when a size filter is applied
      // Compute totals and determine stock status using per-size logic.
      // If a specific size filter is applied, compute totals only for that size.
      const eff = effectiveThresholdForProduct(p);
      // helper: check a color's critical (variant) override
      const criticalForColor = (c) => {
        try {
          const cand = (c && (c.criticalLevel || c.critical || c.minStock || c.reorderLevel));
          const n = parseNum(cand, NaN);
          if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.floor(n));
        } catch (e) {}
        return eff;
      };

      // Compute per-size aggregation
      let total = 0;
      let anySizeLow = false;
      let allSizesZero = true;

      if (filterSize) {
        // Only consider the selected size across colors
        colorsArr.forEach(c => {
          if (Array.isArray(c.sizes)) {
            c.sizes.forEach(s => {
              if (String(s.eu) === String(filterSize)) {
                const q = parseNum(s.stock, 0);
                total += q;
                const crit = criticalForColor(c);
                if (q <= crit) anySizeLow = true;
                if (q > 0) allSizesZero = false;
              }
            });
          } else if (c.sizes && typeof c.sizes === 'object') {
            const q = parseNum(c.sizes[String(filterSize)] || c.sizes[filterSize] || 0, 0);
            total += q;
            const crit = criticalForColor(c);
            if (q <= crit) anySizeLow = true;
            if (q > 0) allSizesZero = false;
          }
        });
      } else {
        // Consider all sizes across all colors
        colorsArr.forEach(c => {
          if (Array.isArray(c.sizes)) {
            c.sizes.forEach(s => {
              const q = parseNum(s.stock, 0);
              total += q;
              const crit = criticalForColor(c);
              if (q <= crit) anySizeLow = true;
              if (q > 0) allSizesZero = false;
            });
          } else if (c.sizes && typeof c.sizes === 'object') {
            Object.keys(c.sizes).forEach(k => {
              const q = parseNum(c.sizes[k], 0);
              total += q;
              const crit = criticalForColor(c);
              if (q <= crit) anySizeLow = true;
              if (q > 0) allSizesZero = false;
            });
          } else {
            // fallback: treat numeric fields on color as aggregate
            const q = parseNum(c.qty, parseNum(c.stock, parseNum(c.inventory, 0)));
            total += q;
            const crit = criticalForColor(c);
            if (q <= crit) anySizeLow = true;
            if (q > 0) allSizesZero = false;
          }
        });
      }

      // Determine stockStatus: 'out' if every size is zero, 'low' if any size <= critical, otherwise 'in'
      const stockStatus = (total === 0 || allSizesZero) ? 'out' : (anySizeLow ? 'low' : 'in');
      const matchesStock = !filterStock || stockStatus === filterStock;
      const matchesStatus = !filterStatus || p.status === filterStatus;
      return matchesText && matchesBrand && matchesCat && matchesSize && matchesStock && matchesStatus;
    });

    

    tbody.innerHTML = filtered.map(p => {
      // snapshot the displayed product for modal use
      try { displayedProductCache[String(p.id)] = JSON.parse(JSON.stringify(p)); } catch (e) { displayedProductCache[String(p.id)] = p; }
      // small helper: pick the first non-empty field from candidates
      const pick = (obj, keys, dflt = '') => {
        if (!obj || typeof obj !== 'object') return dflt;
        for (const k of keys) {
          try { const v = obj[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; } catch (e) { /* continue */ }
        }
        return dflt;
      };

      const displayBrand = pick(p, ['brand','brandName'], '');
      const displayModel = pick(p, ['model','name','title','productName'], '');
      const displaySku = pick(p, ['sku'], p.id || '');
  const displayStatus = pick(p, ['status','state','availability'], '');

  // colors fallback: try product.colors or variants map (grouped by several possible keys)
      let colorsArr = Array.isArray(p.colors) ? p.colors : [];
      if (!colorsArr.length && firebaseState.variantsByProductId) {
        const map = firebaseState.variantsByProductId;
        const candidates = [p.id, p.productId, p.sku, String(p.id || '')];
        for (const c of candidates) {
          if (!c) continue;
          if (Array.isArray(map[c]) && map[c].length) { colorsArr = map[c]; break; }
        }
      }

      // per-product effective low-stock threshold
      const eff = effectiveThresholdForProduct(p);

      const colors = colorsArr.map(c => {
        const stock = totalStockForColor(c);
        const status = stock === 0 ? 'out' : (stock <= eff ? 'low' : 'in');
        return `<span class="badge ${status}" title="${(availableSizes(c) || []).join(', ') || 'None'}">${c.name} (${stock})</span>`;
      }).join(' ');

  const total = totalStockForProduct(p);
  const totalStatus = total === 0 ? 'out' : (total <= eff ? 'low' : 'in');
      const price = `₱${(parseNum(p.pricing?.sale, 0) || parseNum(p.pricing?.original, 0))}`;
      const bulkBox = state.ui.bulkMode ? `<input type="checkbox" class="bulkSel" data-id="${p.id}" ${state.ui.selectedProductIds.has(p.id) ? 'checked' : ''}/>` : '';
      const catDisplay = (p.category || '').trim();
  const tags = computeTags(p);
  const tagsHtml = tags.length ? tags.map(t => {
    const cls = (t && typeof t === 'string') ? t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') : '';
    return `<span class="tag ${cls}">${t}</span>`;
  }).join(' ') : '';
  // Gender: allow array or comma-separated string
  const gRaw = p.gender || [];
  const genderArr = Array.isArray(gRaw) ? gRaw : (typeof gRaw === 'string' ? gRaw.split(',').map(s => s.trim()) : []);
  const genderHtml = genderArr.length ? genderArr.map(g => `<span class="badge gender-badge">${g}</span>`).join(' ') : '';

      return `<tr>
        <td class="bulk-col">${bulkBox}</td>
        <td>${displayBrand}</td>
        <td>${displaySku || ''}</td>
        <td>${displayModel}</td>
        <td>${catDisplay}</td>
  <td class="status ${displayStatus}">${displayStatus}</td>
  <td class="gender-cell"><div class="cell-stack">${genderHtml || ''}</div></td>
  <td class="tags-cell">${tagsHtml || ''}</td>
    <td class="colors-cell"><div class="cell-stack">${colors || '<span class="badge out">No colors</span>'}</div></td>
        <td><span class="badge ${totalStatus}">${total}</span></td>
        <td>${price}</td>
        <td class="actions-col">
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="secondary" data-action="edit" data-id="${p.id}">Edit</button>
            <button class="secondary" data-action="variants" data-id="${p.id}">Variants</button>
            <button class="danger" data-action="delete" data-id="${p.id}">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    qsa('.bulkSel').forEach(cb => cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id; if (e.target.checked) state.ui.selectedProductIds.add(id); else state.ui.selectedProductIds.delete(id);
      updateSelectedCount();
    }));

    updateSelectedCount();

    // Bind row actions
    qsa('[data-action="edit"]').forEach(btn => btn.addEventListener('click', () => openProductModal(btn.dataset.id)));
    qsa('[data-action="variants"]').forEach(btn => btn.addEventListener('click', () => openVariantModal(btn.dataset.id)));
    qsa('[data-action="delete"]').forEach(btn => btn.addEventListener('click', () => deleteProduct(btn.dataset.id)));
  }

  function updateSelectedCount() {
    const el = qs('#selectedCount'); if (!el) return;
    el.textContent = String(state.ui.selectedProductIds.size);
  }

  // Product modal
  function openProductModal(productId) {
    // Redirect to the dedicated Add Product page when creating a new item
    if (!productId) { window.location.href = 'add-product.html'; return; }
    const dlg = qs('#productModal');
    const isEdit = !!productId;
    state.ui.editingProductId = productId || null;
    qs('#productModalTitle').textContent = isEdit ? 'Edit Product' : 'Add Product';
  const brand = qs('#prodBrand');
  const model = qs('#prodModel');
  const cat = qs('#prodCategory');
  const genderMen = qs('#prodGenderMen');
  const genderWomen = qs('#prodGenderWomen');
  const genderUnisex = qs('#prodGenderUnisex');
    const statusSel = qs('#prodStatus');
    const pOrig = qs('#priceOriginal');
    const pSale = qs('#priceSale');
    const skuEl = qs('#prodSKU');
    const descEl = qs('#prodDescription');
    // images handled via state.ui.productModalImages

    if (isEdit) {
      // Prefer the product data as rendered in the table (stable) to avoid flicker from snapshots.
      // Additionally, read the visible table row values directly from the DOM to ensure the
      // modal reflects exactly what's shown to the user (text content, tags, and price formatting).
      const p = (displayedProductCache && displayedProductCache[productId]) ? displayedProductCache[productId] : state.products.find(x => x.id === productId);

      const getRowDataFromTable = (id) => {
        try {
          const btn = document.querySelector(`[data-action="edit"][data-id="${id}"]`);
          if (!btn) return null;
          const tr = btn.closest('tr');
          if (!tr) return null;
          const cells = tr.children;
          const brandTxt = (cells[1] && cells[1].textContent) ? cells[1].textContent.trim() : '';
          const skuTxt = (cells[2] && cells[2].textContent) ? cells[2].textContent.trim() : '';
          const modelTxt = (cells[3] && cells[3].textContent) ? cells[3].textContent.trim() : '';
          const catTxt = (cells[4] && cells[4].textContent) ? cells[4].textContent.trim() : '';
          const statusTxt = (cells[5] && cells[5].textContent) ? cells[5].textContent.trim() : '';
          const priceTxt = (cells[9] && cells[9].textContent) ? cells[9].textContent.trim() : '';
          // Extract numeric price if present (e.g., "₱1,234.00")
          let priceNum = 0;
          const m = priceTxt.match(/[\d,\.]+/);
          if (m) priceNum = parseFloat(m[0].replace(/,/g, '')) || 0;
          const tags = Array.from(tr.querySelectorAll('.tags-cell .tag')).map(el => el.textContent.trim());
          return { brand: brandTxt, sku: skuTxt, model: modelTxt, category: catTxt, status: statusTxt, price: priceNum, tags };
        } catch (e) { return null; }
      };

      const dom = getRowDataFromTable(productId);

      // Fill inputs preferring the visible DOM values when available, otherwise fall back to the product object
      brand.value = (dom && dom.brand) ? dom.brand : (p.brand || '');
      model.value = (dom && dom.model) ? dom.model : (p.model || '');
      cat.value = (dom && dom.category) ? dom.category : (p.category || '');
      statusSel.value = (dom && dom.status) ? dom.status : (p.status || '');
      // Set gender checkboxes based on product data (allow string or array)
      try {
        const g = p.gender || [];
        const genders = Array.isArray(g) ? g : (typeof g === 'string' ? g.split(',').map(s => s.trim()) : []);
        if (genderMen) genderMen.checked = genders.includes('Men');
        if (genderWomen) genderWomen.checked = genders.includes('Women');
        if (genderUnisex) genderUnisex.checked = genders.includes('Unisex') || genders.length === 0;
      } catch (e) {
        if (genderUnisex) genderUnisex.checked = true;
      }
      pOrig.value = (dom && Number.isFinite(dom.price) && dom.price > 0) ? dom.price : (p.pricing?.original || '');
      pSale.value = p.pricing?.sale || '';
      /* cost deprecated */
      if (skuEl) skuEl.value = (dom && dom.sku) ? dom.sku : (p.sku || '');
      if (descEl) descEl.value = p.description || '';
      // AR link: populate from product if present (support variants of naming)
      try {
        const arEl = qs('#prodARLink');
        const qrPreview = qs('#prodARQrPreview');
        const arVal = p.arLink || p.ar_link || p.arUrl || p.ar_url || '';
        if (arEl) arEl.value = arVal || '';
        if (arVal && qrPreview) { qrPreview.src = qrImageUrlFor(arVal, 240); qrPreview.style.display = ''; }
        else if (qrPreview) { qrPreview.src = ''; qrPreview.style.display = 'none'; }
      } catch (e) {}
  // populate critical level input (if present on product)
  try { const crit = (p.criticalLevel !== undefined) ? p.criticalLevel : (p.critical_level !== undefined ? p.critical_level : ''); const critEl = qs('#prodCriticalLevel'); if (critEl) critEl.value = (crit !== undefined && crit !== null) ? String(crit) : ''; } catch(e){}
      // Manual tags
      const manual = Array.isArray(p.tagsManual) ? p.tagsManual : [];
      // If DOM tags were detected, use them to set the manual tag checkboxes so the modal mirrors the table
      if (dom && Array.isArray(dom.tags) && dom.tags.length) {
        // sync manual array with DOM-detected tags (but don't overwrite p.tagsManual variable)
        const domTags = dom.tags;
        // mark checkboxes based on presence
        if (domTags.includes('New')) manual.push('New');
        if (domTags.includes('Sale')) manual.push('Sale');
        if (domTags.includes('Pre-Order')) manual.push('Pre-Order');
        if (domTags.includes('Best Seller')) manual.push('Best Seller');
        if (domTags.includes('Try On!')) manual.push('Try On!');
      }
      const tagNew = qs('#tagNew'); if (tagNew) tagNew.checked = manual.includes('New');
      const tagSale = qs('#tagSale'); if (tagSale) tagSale.checked = manual.includes('Sale');
      const tagPre = qs('#tagPreOrder'); if (tagPre) tagPre.checked = manual.includes('Pre-Order');
      const tagBest = qs('#tagBestSeller'); if (tagBest) tagBest.checked = manual.includes('Best Seller');
      const tagTryOn = qs('#tagTryOn'); if (tagTryOn) tagTryOn.checked = manual.includes('Try On!');
      state.ui.productModalImages = Array.isArray(p.images) ? p.images.map(it => {
        if (typeof it === 'string') return { url: it, name: displayNameFromUrl(it) };
        if (it && typeof it === 'object') {
          if (it.url) return { url: it.url, name: it.name || displayNameFromUrl(it.url), pathfile: it.pathfile };
          if (it.pathfile) return { url: '', name: it.pathfile, pathfile: it.pathfile };
        }
        return { url: '', name: '[image]' };
      }) : [];
      renderImagesList();
      // Hide initial variant builder on edit; use Variants modal instead
      const initSec = qs('#initialVariantSection'); if (initSec) initSec.style.display = 'none';
      state.ui.productModalColors = [];
    } else {
  brand.value = ''; model.value = ''; cat.value = '';
  if (genderMen) genderMen.checked = false;
  if (genderWomen) genderWomen.checked = false;
  if (genderUnisex) genderUnisex.checked = true;
  statusSel.value = 'active'; pOrig.value = ''; pSale.value = '';
      if (skuEl) skuEl.value = '';
      if (descEl) descEl.value = '';
  // clear AR inputs on Add
  try { const arEl = qs('#prodARLink'); const qrPreview = qs('#prodARQrPreview'); if (arEl) arEl.value = ''; if (qrPreview) { qrPreview.src = ''; qrPreview.style.display = 'none'; } } catch(e){}
  // clear critical level on Add
  try { const critEl = qs('#prodCriticalLevel'); if (critEl) critEl.value = ''; } catch(e){}
      // Clear manual tags on add
      const tagNew = qs('#tagNew'); if (tagNew) tagNew.checked = false;
      const tagSale = qs('#tagSale'); if (tagSale) tagSale.checked = false;
      const tagPre = qs('#tagPreOrder'); if (tagPre) tagPre.checked = false;
      const tagBest = qs('#tagBestSeller'); if (tagBest) tagBest.checked = false;
      const tagTryOn = qs('#tagTryOn'); if (tagTryOn) tagTryOn.checked = false;
      // Show initial variant builder on add
      const initSec = qs('#initialVariantSection'); if (initSec) initSec.style.display = 'block';
      state.ui.productModalColors = [];
      state.ui.productModalImages = [];
      renderImagesList();
      renderInitialVariants();
    }

    dlg.showModal();
    // wire Generate QR button (idempotent)
    try {
      const genBtn = qs('#prodGenerateQrBtn');
      const arEl = qs('#prodARLink');
      const qrPreview = qs('#prodARQrPreview');
      if (genBtn && arEl) {
        genBtn.removeEventListener('click', prodGenerateQrHandler);
        genBtn.addEventListener('click', prodGenerateQrHandler);
      }
      function prodGenerateQrHandler() {
        try {
          const v = (arEl && arEl.value) ? String(arEl.value).trim() : '';
          if (!v) { alert('Enter an AR webfilter link to generate the QR.'); return; }
          const url = qrImageUrlFor(v, 300);
          if (qrPreview) { qrPreview.src = url; qrPreview.style.display = ''; }
        } catch (ee) { console.error('prodGenerateQrHandler', ee); }
      }
    } catch (e) { console.warn('failed to wire Generate QR', e); }
  }

  // Debug helper: expose a function to inspect how a product's colors/sizes are
  // resolved by the renderer (useful when inventory shape varies).
  try {
    window.debugResolvedProduct = function(idOrSku) {
      try {
        const p = (state.products || []).find(x => String(x.id) === String(idOrSku) || String(x.sku) === String(idOrSku));
        if (!p) { console.warn('Product not found for', idOrSku); return null; }
        let colorsArr = Array.isArray(p.colors) ? p.colors : [];
        if ((!colorsArr || colorsArr.length === 0) && window.firebaseState && window.firebaseState.variantsByProductId) {
          const map = window.firebaseState.variantsByProductId;
          const candidates = [p.id, p.productId, p.sku, String(p.id || '')];
          for (const c of candidates) { if (!c) continue; if (Array.isArray(map[c]) && map[c].length) { colorsArr = map[c]; break; } }
        }
        if ((!colorsArr || colorsArr.length === 0) && p.sizes && typeof p.sizes === 'object') {
          colorsArr = [{ id: p.id + '-default', name: p.title || p.name || p.model || 'Default', sizes: sizesObjectToArray(p.sizes) }];
        }
        const summary = { id: p.id, sku: p.sku, title: p.title || p.name || p.model, effectiveThreshold: effectiveThresholdForProduct(p), totalFromColors: (Array.isArray(colorsArr) ? colorsArr.reduce((acc,c) => acc + totalStockForColor(c),0) : totalStockForProduct(p)), colors: [] };
        (colorsArr || []).forEach(c => {
          summary.colors.push({ id: c.id, name: c.name, total: totalStockForColor(c), sizes: Array.isArray(c.sizes) ? c.sizes : sizesObjectToArray(c.sizes) });
        });
        console.group('debugResolvedProduct', summary.title || summary.sku || summary.id);
        console.log(summary);
        console.table(summary.colors.map(c => ({ id: c.id, name: c.name, total: c.total })));
        console.groupEnd();
        return summary;
      } catch (e) { console.error('debugResolvedProduct failed', e); return null; }
    };
  } catch (e) {}

  function saveProductFromModal() {
    const brand = qs('#prodBrand').value.trim();
    const model = qs('#prodModel').value.trim();
    const cat = qs('#prodCategory').value.trim();
  // Read gender checkboxes; allow multiple selections. If none selected, default to Unisex.
  const genders = [];
  const genderMenEl = qs('#prodGenderMen'); if (genderMenEl && genderMenEl.checked) genders.push('Men');
  const genderWomenEl = qs('#prodGenderWomen'); if (genderWomenEl && genderWomenEl.checked) genders.push('Women');
  const genderUnisexEl = qs('#prodGenderUnisex'); if (genderUnisexEl && genderUnisexEl.checked) genders.push('Unisex');
  const genderSel = genders.length ? genders : ['Unisex'];
    const statusSel = qs('#prodStatus').value;
    const pOrig = parseNum(qs('#priceOriginal').value, 0);
    const pSale = parseNum(qs('#priceSale').value, 0);
    const skuPreview = (qs('#prodSKU')?.value || '').trim();
    const desc = (qs('#prodDescription')?.value || '').trim();
  const critVal = qs('#prodCriticalLevel') ? qs('#prodCriticalLevel').value : '';

    // Manual tags from modal
    const manual = [];
    const tagNew = qs('#tagNew'); if (tagNew && tagNew.checked) manual.push('New');
    const tagSale = qs('#tagSale'); if (tagSale && tagSale.checked) manual.push('Sale');
    const tagPre = qs('#tagPreOrder'); if (tagPre && tagPre.checked) manual.push('Pre-Order');
    const tagBest = qs('#tagBestSeller'); if (tagBest && tagBest.checked) manual.push('Best Seller');
    const tagTryOn = qs('#tagTryOn'); if (tagTryOn && tagTryOn.checked) manual.push('Try On!');

  if (!brand || !model) { alert('Brand and Model are required'); return; }
  if (pOrig <= 0) { alert('Original price is required'); return; }
  // Images are optional: do not force users to import images to save

    // Prevent duplicates: do not allow another product with the same Brand + Model
    const pid = state.ui.editingProductId;
    const modelKey = model.toLowerCase();
    const brandKey = brand.toLowerCase();
    const duplicate = state.products.some(p => (p.id !== pid) && (String(p.model||'').trim().toLowerCase() === modelKey) && (String(p.brand||'').trim().toLowerCase() === brandKey));
    if (duplicate) { alert('A product with the same brand and model already exists.'); return; }

    if (pid) {
      const p = state.products.find(x => x.id === pid);
      // Confirm archiving when changing status to archived
      if (statusSel === 'archived' && p.status !== 'archived') {
        const ok = confirm(`Archive ${p.brand} ${p.model}?\nArchived products are hidden from active listings.`);
        if (!ok) { return; }
      }
  p.brand = brand; p.model = model; p.category = cat; p.gender = Array.isArray(genderSel) ? genderSel : [genderSel]; p.status = statusSel;
  p.pricing = p.pricing || { original: 0, sale: 0, cost: 0 };
  p.pricing.original = pOrig; p.pricing.sale = pSale; p.pricing.cost = 0;
      // per-product critical level: empty -> unset, numeric -> clamp & set
      try {
        if (critVal !== null && String(critVal).trim() !== '') {
          p.criticalLevel = clampNum(Math.floor(parseNum(critVal, state.settings.lowStockThreshold)), 1, 999);
        } else {
          delete p.criticalLevel;
        }
      } catch(e) {}
      // Keep existing SKU unless empty; regenerate if missing
      if (!p.sku) p.sku = generateProductSKU(brand, model, cat);
      p.description = desc;
  p.images = state.ui.productModalImages.map(it => it.url || it.pathfile || '').filter(Boolean);
      p.tagsManual = manual;
  // AR link handling
  try { const arVal = (qs('#prodARLink') && qs('#prodARLink').value) ? String(qs('#prodARLink').value).trim() : ''; if (arVal) { p.arLink = arVal; p.arQr = qrImageUrlFor(arVal, 300); } else { delete p.arLink; delete p.arQr; } } catch(e){}
      // Ensure size-level SKUs exist
      ensureSizeSkusForProduct(p);
      // Sync to Firestore when available
      if (firebaseState.enabled) {
        upsertProductToFirestore(p).then(() => syncVariantsForProduct(p));
      }
    } else {
      // Require at least one color with sizes when adding
      const colors = state.ui.productModalColors.filter(c => (c.name || '').trim().length);
      if (!colors.length) { alert('Add at least one color with stock'); return; }
      if (statusSel === 'archived') {
        const ok = confirm('Create this product in archived state?');
        if (!ok) { return; }
      }
  const newP = newProduct({ brand, model, category: cat, status: statusSel, images: [], pricing: { original: pOrig, sale: pSale, cost: 0 }, description: desc, gender: Array.isArray(genderSel) ? genderSel : [genderSel] });
  newP.images = state.ui.productModalImages.map(it => it.url || it.pathfile || '').filter(Boolean);
      newP.tagsManual = manual;
  // AR link for new product
  try { const arVal = (qs('#prodARLink') && qs('#prodARLink').value) ? String(qs('#prodARLink').value).trim() : ''; if (arVal) { newP.arLink = arVal; newP.arQr = qrImageUrlFor(arVal, 300); } } catch(e){}
      // set critical level if provided
      try {
        if (critVal !== null && String(critVal).trim() !== '') {
          newP.criticalLevel = clampNum(Math.floor(parseNum(critVal, state.settings.lowStockThreshold)), 1, 999);
        }
      } catch(e) {}
      // Copy colors and sizes
      newP.colors = colors.map(c => {
        const normalizedImages = normalizeVariantImages(c.images || [], c.image || '');
        return {
          id: c.id,
          name: c.name,
          code: c.code,
          image: normalizedImages.find(x => x && String(x).trim()) || '',
          images: normalizedImages,
          sizes: c.sizes.map(s => ({ eu: s.eu, stock: clampNum(parseNum(s.stock,0), 0, 9999), sku: s.sku || '' }))
        };
      });
      // Ensure size-level SKUs exist
      ensureSizeSkusForProduct(newP);
      state.products.push(newP);
      // Sync created product and its variants to Firestore when available
      if (firebaseState.enabled) {
        upsertProductToFirestore(newP).then(() => syncVariantsForProduct(newP));
      }
    }
    saveAll();
    qs('#productModal').close();
    renderAll();
  }

  function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    state.products = state.products.filter(p => p.id !== id);
    saveAll();
    renderAll();
    if (firebaseState.enabled) deleteProductFromFirestore(id);
  }

  // Images management in Add/Edit Product modal
  function renderImagesList() {
    const list = qs('#imagesList'); if (!list) return;
    const raw = state.ui.productModalImages || [];
    const imgs = raw.map(it => {
      if (typeof it === 'string') return { url: it, name: displayNameFromUrl(it) };
      if (it && typeof it === 'object') {
        if (it.url) return { url: it.url, name: it.name || displayNameFromUrl(it.url), pathfile: it.pathfile };
        if (it.pathfile) return { url: '', name: it.pathfile, pathfile: it.pathfile };
        return { url: it.url || '', name: it.name || '[image]' };
      }
      return { url: '', name: '[image]' };
    });
    state.ui.productModalImages = imgs;
    list.innerHTML = imgs.map((item, idx) => `<div class="image-item" data-index="${idx}">
      ${item.url ? `<img src="${item.url}" alt="Product image ${idx+1}" />` : `<div class="image-placeholder">${item.name}</div>`}
      <span class="image-name" title="${item.name}">${item.name}</span>
      <div class="image-actions">
        <button class="danger" data-action="remove-image">Remove</button>
      </div>
    </div>`).join('');
    list.querySelectorAll('[data-action="remove-image"]').forEach(btn => btn.addEventListener('click', () => {
      const idx = parseNum(btn.closest('.image-item').dataset.index, -1);
      if (idx >= 0) {
        state.ui.productModalImages.splice(idx, 1);
        renderImagesList();
      }
    }));
  }

  function addImagesFromFileInput() {
    const inp = qs('#imageFileInput'); if (!inp) return;
    const files = Array.from(inp.files || []);
    if (!files.length) { alert('Choose image files'); return; }
    const readers = files.map(file => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve({ url: fr.result, name: file.name });
      fr.onerror = reject;
      fr.readAsDataURL(file);
    }));
    Promise.all(readers)
      .then(items => { state.ui.productModalImages.push(...items); renderImagesList(); inp.value = ''; })
      .catch(() => alert('Failed to import one or more images'));
  }

  // Variants modal
  function openVariantModal(productId) {
    const dlg = qs('#variantModal');
    state.ui.editingVariantProductId = productId;
    const p = state.products.find(x => x.id === productId);
    // Sync manual Try On tag checkbox with product
    try {
      const tagTry = qs('#variantTagTryOn');
      const manual = Array.isArray(p && p.tagsManual) ? p.tagsManual : [];
      if (tagTry) tagTry.checked = manual.some(t => String(t || '').toLowerCase() === 'try on!'.toLowerCase());
    } catch (e) {}
    const list = qs('#variantColorsList');
    // Render color list (actions moved into each color's size card for proximity)
    p.colors.forEach(c => applyColorImages(c));
    list.innerHTML = p.colors.map(c => {
      const stock = totalStockForColor(c);
      const sizeCount = Array.isArray(c.sizes) ? c.sizes.length : 0;
      const imageCount = countColorImages(c);
      return `<div class="color-item" data-id="${c.id}">
        <div class="color-item-info">
          <span class="color-dot" style="background:${c.code}"></span>
          <div class="color-item-text">
            <strong>${c.name}</strong>
            <span class="muted">${stock} in stock • ${sizeCount} sizes • ${imageCount}/4 images</span>
          </div>
        </div>
        <div class="color-actions">
          <button class="secondary" data-action="edit-color">Edit</button>
          <button class="danger" data-action="delete-color">Delete</button>
        </div>
      </div>`;
    }).join('');

    bindColorActions(list);

    // Ensure a selected color is set; default to first
    const firstColor = p.colors && p.colors[0];
    if (!state.ui.editingVariantColorId || !p.colors.find(c => c.id === state.ui.editingVariantColorId)) {
      state.ui.editingVariantColorId = firstColor ? firstColor.id : null;
    }

    // Clicking a color selects it and re-renders the editor
    list.querySelectorAll('.color-item').forEach(item => item.addEventListener('click', (ev) => {
      // ignore clicks on the action buttons inside the color item
      if (ev.target.closest('.color-actions')) return;
      const id = item.dataset.id;
      state.ui.editingVariantColorId = id;
      renderSizesEditor(p);
    }));

    renderSizesEditor(p);

    dlg.showModal();
  }

  function bindColorActions(list) {
    list.querySelectorAll('[data-action="edit-color"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.closest('.color-item').dataset.id;
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === id);
      const name = prompt('Color name', c.name);
      if (name === null) return;
      const code = prompt('Color hex (#rrggbb)', c.code);
      if (code === null) return;
      c.name = name.trim() || c.name; c.code = code || c.code; saveAll(); openVariantModal(p.id);
    }));
    list.querySelectorAll('[data-action="delete-color"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.closest('.color-item').dataset.id;
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      if (!confirm('Delete this color variant?')) return;
      p.colors = p.colors.filter(y => y.id !== id);
      saveAll(); openVariantModal(p.id);
    }));
  }

  function renderSizesEditor(p) {
    const editor = qs('#sizesEditor');
    editor.innerHTML = '';
    if (!p.colors.length) {
      editor.innerHTML = '<p class="muted">No colors yet. Add one above.</p>';
      return;
    }
    const selId = state.ui.editingVariantColorId || null;
    const listEl = qs('#variantColorsList');
    if (listEl) listEl.querySelectorAll('.color-item').forEach(it => it.classList.toggle('active', it.dataset.id === selId));

    const colorsToRender = selId ? p.colors.filter(c => c.id === selId) : p.colors;
    colorsToRender.forEach(color => {
      const card = document.createElement('div'); card.className = 'size-card';
      // Header: color name + add size + clear
      const fill = document.createElement('div'); fill.className = 'fill-actions';
      fill.innerHTML = `
        <div class="color-header">
          <strong class="color-name">${color.name}</strong>
          <button class="secondary" data-action="add-size" data-id="${color.id}">Add Size</button>
          <button class="secondary clear-btn" data-action="clear-all" data-id="${color.id}">Clear</button>
        </div>`;
      card.appendChild(fill);

      applyColorImages(color);
      const imageCount = countColorImages(color);
      const imageSection = document.createElement('div');
      imageSection.className = 'variant-images-section';
      imageSection.innerHTML = `
        <div class="variant-images-header">
          <div>
            <strong>Variant Images</strong>
            <div class="muted">Upload 4 images for this color (front, side, back, detail).</div>
          </div>
          <div class="variant-images-meta">
            <span class="variant-images-count">${imageCount}/4 uploaded</span>
            <button type="button" class="ghost" data-action="variant-images-clear" data-color="${color.id}">Clear images</button>
          </div>
        </div>
        <div class="variant-images-grid">
          ${color.images.map((img, idx) => {
            const label = `Image ${idx + 1}`;
            const preview = img
              ? `<img src="${img}" alt="${color.name} ${label}">`
              : `<div class="variant-image-placeholder">${label}</div>`;
            return `
              <div class="variant-image-slot" data-index="${idx}">
                <div class="variant-image-preview">${preview}</div>
                <div class="variant-image-actions">
                  <label class="secondary small-btn">
                    <input type="file" accept="image/*" data-action="variant-image-upload" data-color="${color.id}" data-index="${idx}">
                    Upload
                  </label>
                  <button type="button" class="ghost danger-text small-btn" data-action="variant-image-remove" data-color="${color.id}" data-index="${idx}">Remove</button>
                </div>
              </div>`;
          }).join('')}
        </div>
        ${imageCount < 4 ? '<div class="variant-images-warning">Upload all 4 images before saving.</div>' : ''}
      `;
      card.appendChild(imageSection);

      const grid = document.createElement('div'); grid.className = 'size-grid';
      if (!color.sizes.length) {
        const emptyRow = document.createElement('div');
        emptyRow.className = 'size-row';
        emptyRow.innerHTML = '<span class="muted">No sizes added for this color.</span>';
        grid.appendChild(emptyRow);
      } else {
        color.sizes.forEach(s => {
          const row = document.createElement('div'); row.className = 'size-row';
          row.innerHTML = `
            <label>${s.eu}EU</label>
            <input type="number" min="0" step="1" value="${s.stock}" data-color="${color.id}" data-size="${s.eu}" />
            <div class="qty-controls">
              <button type="button" class="qty-btn" data-action="decr" data-color="${color.id}" data-size="${s.eu}">−</button>
              <button type="button" class="qty-btn" data-action="incr" data-color="${color.id}" data-size="${s.eu}">+</button>
            </div>
            <button type="button" class="danger" data-action="remove-size" data-color="${color.id}" data-size="${s.eu}">Remove</button>
          `;
          grid.appendChild(row);
        });
      }
      card.appendChild(grid);
      editor.appendChild(card);
    });

    // Bind add size
    editor.querySelectorAll('[data-action="add-size"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === id);
      let eu = prompt('Enter EU size to add (e.g. 36):');
      if (!eu) return;
      eu = parseNum(eu, null);
      if (!eu || !EU_SIZES.includes(eu)) { alert('Size must be between 35 and 49 EU.'); return; }
      if (c.sizes.find(z => z.eu === eu)) { alert('Invalid or duplicate size.'); return; }
      c.sizes.push({ eu, stock: 0, sku: '' });
      saveAll(); openVariantModal(p.id);
    }));

    // Bind remove size
    editor.querySelectorAll('[data-action="remove-size"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.color;
      const eu = parseNum(btn.dataset.size);
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      c.sizes = c.sizes.filter(z => z.eu !== eu);
      saveAll(); openVariantModal(p.id);
    }));

    // Bind clear all sizes for color
    editor.querySelectorAll('[data-action="clear-all"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.id;
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      if (!c) return;
      c.sizes.forEach(s => { s.stock = 0; });
      saveAll(); openVariantModal(p.id);
    }));

    // Bind image uploads
    editor.querySelectorAll('[data-action="variant-image-upload"]').forEach(inp => inp.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const colorId = e.target.dataset.color;
      const idx = parseNum(e.target.dataset.index, 0);
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      if (!c) return;
      const fr = new FileReader();
      fr.onload = () => {
        applyColorImages(c);
        c.images[idx] = fr.result;
        applyColorImages(c);
        saveAll();
        openVariantModal(p.id);
      };
      fr.onerror = () => alert('Failed to read image file.');
      fr.readAsDataURL(file);
    }));

    // Bind image remove
    editor.querySelectorAll('[data-action="variant-image-remove"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.color;
      const idx = parseNum(btn.dataset.index, 0);
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      if (!c) return;
      applyColorImages(c);
      c.images[idx] = '';
      applyColorImages(c);
      saveAll(); openVariantModal(p.id);
    }));

    // Bind clear all images
    editor.querySelectorAll('[data-action="variant-images-clear"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.color;
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      if (!c) return;
      c.images = normalizeVariantImages([], '');
      c.image = '';
      saveAll(); openVariantModal(p.id);
    }));

    // Bind number inputs change
    editor.querySelectorAll('input[type="number"]').forEach(inp => {
      inp.addEventListener('change', (e) => {
        const colorId = e.target.dataset.color;
        const eu = parseNum(e.target.dataset.size);
        const qty = clampNum(parseNum(e.target.value), 0, 9999);
        const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
        const c = p.colors.find(y => y.id === colorId);
        const s = c.sizes.find(z => z.eu === eu);
        if (s) s.stock = qty; saveAll();
      });
    });

    // Bind qty +/- buttons
    editor.querySelectorAll('.qty-btn').forEach(btn => btn.addEventListener('click', (e) => {
      const action = btn.dataset.action;
      const colorId = btn.dataset.color;
      const eu = parseNum(btn.dataset.size);
      const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
      const c = p.colors.find(y => y.id === colorId);
      const s = c.sizes.find(z => z.eu === eu);
      if (!s) return;
      const delta = action === 'incr' ? 1 : -1;
      s.stock = clampNum((Number(s.stock||0) || 0) + delta, 0, 9999);
      saveAll(); openVariantModal(p.id);
    }));
  }

  function addColorFromModal() {
    const name = qs('#variantColorName').value.trim();
    const code = qs('#variantColorCode').value || '#ffffff';
    if (!name) { alert('Enter a color name'); return; }
    const p = state.products.find(x => x.id === state.ui.editingVariantProductId);
    p.colors.push(newColor(name, code));
    saveAll();
    qs('#variantColorName').value = '';
    openVariantModal(p.id);
  }

  // Initial variants in Add Product modal
  function addInitialColorFromModal() {
    const name = qs('#initialColorName').value.trim();
    const code = qs('#initialColorCode').value || '#ffffff';
    if (!name) { alert('Enter a color name'); return; }
    state.ui.productModalColors.push(newColor(name, code));
    qs('#initialColorName').value = '';
    renderInitialVariants();
  }

  function bindInitialColorActions(list) {
    list.querySelectorAll('[data-action="edit-init-color"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.closest('.color-item').dataset.id;
      const c = state.ui.productModalColors.find(y => y.id === id);
      const name = prompt('Color name', c.name);
      if (name === null) return;
      const code = prompt('Color hex (#rrggbb)', c.code);
      if (code === null) return;
      c.name = name.trim() || c.name; c.code = code || c.code; renderInitialVariants();
    }));
    list.querySelectorAll('[data-action="delete-init-color"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.closest('.color-item').dataset.id;
      state.ui.productModalColors = state.ui.productModalColors.filter(y => y.id !== id);
      renderInitialVariants();
    }));
  }

  function renderInitialVariants() {
    const colors = state.ui.productModalColors;
    const list = qs('#initialColorsList');
    const editor = qs('#initialSizesEditor');
    if (!list || !editor) return;
    list.innerHTML = colors.map(c => `<div class="color-item" data-id="${c.id}">
      <span class="color-dot" style="background:${c.code}"></span>
      <strong>${c.name || '(unnamed)'}</strong>
      <span class="muted">(${totalStockForColor(c)})</span>
      <div class="color-actions">
        <button class="secondary" data-action="edit-init-color">Edit</button>
        <button class="danger" data-action="delete-init-color">Delete</button>
      </div>
    </div>`).join('');
    bindInitialColorActions(list);

    editor.innerHTML = '';
    if (!colors.length) {
      editor.innerHTML = '<p class="muted">Add a color above to set stock.</p>';
      return;
    }
    colors.forEach(color => {
      const card = document.createElement('div'); card.className = 'size-card';
      const fill = document.createElement('div'); fill.className = 'fill-actions';
      fill.innerHTML = `<strong>${color.name}</strong>
        <button class="secondary" data-action="add-size-init" data-id="${color.id}">Add Size</button>
        <button class="secondary" data-action="clear-all-init" data-id="${color.id}">Clear</button>`;
      card.appendChild(fill);
      const grid = document.createElement('div'); grid.className = 'size-grid';
      if (!color.sizes.length) {
        const emptyRow = document.createElement('div');
        emptyRow.className = 'size-row';
        emptyRow.innerHTML = '<span class="muted">No sizes added for this color.</span>';
        grid.appendChild(emptyRow);
      } else {
        color.sizes.forEach(s => {
          const row = document.createElement('div'); row.className = 'size-row';
          row.innerHTML = `
            <label>${s.eu}EU</label>
            <input type="number" min="0" step="1" value="${s.stock}" data-init-color="${color.id}" data-size="${s.eu}" />
            <button type="button" class="danger" data-action="remove-size-init" data-color="${color.id}" data-size="${s.eu}">Remove</button>
          `;
          grid.appendChild(row);
        });
      }
      card.appendChild(grid);
      editor.appendChild(card);
    });

    // Bind add size
    editor.querySelectorAll('[data-action="add-size-init"]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const c = state.ui.productModalColors.find(y => y.id === id);
      let eu = prompt('Enter EU size to add (e.g. 36):');
      if (!eu) return;
      eu = parseNum(eu, null);
      if (!eu || !EU_SIZES.includes(eu)) { alert('Size must be between 35 and 49 EU.'); return; }
      if (c.sizes.find(z => z.eu === eu)) { alert('Invalid or duplicate size.'); return; }
      c.sizes.push({ eu, stock: 0, sku: '' });
      renderInitialVariants();
    }));

    // Bind remove size
    editor.querySelectorAll('[data-action="remove-size-init"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.color;
      const eu = parseNum(btn.dataset.size);
      const c = state.ui.productModalColors.find(y => y.id === colorId);
      c.sizes = c.sizes.filter(z => z.eu !== eu);
      renderInitialVariants();
    }));

    // Bind clear all stocks in initial variant editor
    editor.querySelectorAll('[data-action="clear-all-init"]').forEach(btn => btn.addEventListener('click', () => {
      const colorId = btn.dataset.id;
      const c = state.ui.productModalColors.find(y => y.id === colorId);
      if (!c) return;
      c.sizes.forEach(s => { s.stock = 0; });
      renderInitialVariants();
    }));

    // Bind number inputs change
    editor.querySelectorAll('input[type="number"]').forEach(inp => inp.addEventListener('change', (e) => {
      const colorId = e.target.dataset.initColor;
      const eu = parseNum(e.target.dataset.size);
      const qty = clampNum(parseNum(e.target.value), 0, 9999);
      const c = state.ui.productModalColors.find(y => y.id === colorId);
      const s = c.sizes.find(z => z.eu === eu);
      if (s) s.stock = qty;
    }));
  }

  function saveVariantsModal() {
    // Persist variants to Firestore for the editing product (if enabled)
    const pid = state.ui.editingVariantProductId;
    const p = state.products.find(x => x.id === pid);
    // Apply manual Try On tag from variants modal toggle
    try {
      const tagTry = qs('#variantTagTryOn');
      if (p && tagTry) {
        let manual = Array.isArray(p.tagsManual) ? p.tagsManual.filter(Boolean) : [];
        const hasTry = manual.some(t => String(t || '').toLowerCase() === 'try on!'.toLowerCase() || String(t || '').toLowerCase() === 'try on');
        if (tagTry.checked && !hasTry) manual.push('Try On!');
        if (!tagTry.checked && hasTry) manual = manual.filter(t => {
          const val = String(t || '').toLowerCase();
          return val !== 'try on!' && val !== 'try on';
        });
        p.tagsManual = manual;
      }
    } catch (e) {}
    if (p && Array.isArray(p.colors)) {
      const missing = p.colors.filter(c => {
        applyColorImages(c);
        return countColorImages(c) < 4;
      });
      if (missing.length) {
        alert('Please upload 4 images for each color variant before saving. Missing: ' + missing.map(c => c.name || 'Unnamed').join(', '));
        return;
      }
    }
    if (p) {
      // attempt to sync variants; errors are logged inside syncVariantsForProduct
      syncVariantsForProduct(p).finally(() => {
        qs('#variantModal').close();
        renderAll();
      });
    } else {
      qs('#variantModal').close();
      renderAll();
    }
  }

  // Bulk actions
  function setBulkMode(on) {
    state.ui.bulkMode = on; if (!on) state.ui.selectedProductIds.clear(); renderProductsTable();
    updateSelectedCount();
  }

  function openBulkPrice() { qs('#bulkPriceModal').showModal(); }
  function applyBulkPrice() {
    const ids = Array.from(state.ui.selectedProductIds);
    if (!ids.length) { alert('Select products first'); return; }
    const field = qs('#bulkPriceField').value; // original|sale
    const method = qs('#bulkPriceMethod').value; // set|inc_pct|dec_pct|inc_num|dec_num
    const value = parseNum(qs('#bulkPriceValue').value, NaN);
    if (!['original','sale'].includes(field)) { alert('Choose a field'); return; }
    if (!['set','inc_pct','dec_pct','inc_num','dec_num'].includes(method)) { alert('Choose a method'); return; }
    if (!Number.isFinite(value)) { alert('Enter a value'); return; }
    if ((method === 'inc_pct' || method === 'dec_pct') && value < 0) { alert('Percent must be non-negative'); return; }
    if ((method === 'inc_num' || method === 'dec_num') && value < 0) { alert('Amount must be non-negative'); return; }
    state.products.forEach(p => {
      if (!ids.includes(p.id)) return;
      const cur = parseNum(p.pricing?.[field], 0);
      let next = cur;
      if (method === 'set') next = value;
      else if (method === 'inc_pct') next = cur * (1 + value / 100);
      else if (method === 'dec_pct') next = cur * (1 - value / 100);
      else if (method === 'inc_num') next = cur + value;
      else if (method === 'dec_num') next = cur - value;
      p.pricing = p.pricing || { original: 0, sale: 0, cost: 0 };
      p.pricing[field] = Math.max(0, Number(next.toFixed(2)));
    });
    saveAll(); qs('#bulkPriceModal').close(); renderProductsTable();
  }

  function openBulkRestock() { qs('#bulkRestockModal').showModal(); }
  function applyBulkRestock() {
    const ids = Array.from(state.ui.selectedProductIds);
    if (!ids.length) { alert('Select products first'); return; }
    const scope = qs('#bulkRestockScope').value; // all|low|out|size
    const qty = parseNum(qs('#bulkRestockQty').value, null);
    const size = parseNum(qs('#bulkRestockSize').value, null);
    if (qty === null || qty < 0) { alert('Enter a non-negative quantity'); return; }
    const qtyInt = Math.floor(clampNum(qty, 0, 9999));
    if (scope === 'size') {
      if (!Number.isFinite(size)) { alert('Enter a size (EU 35–49)'); return; }
      if (!EU_SIZES.includes(size)) { alert('Size must be between 35 and 49 EU'); return; }
    }
    const threshold = state.settings.lowStockThreshold;
    state.products.forEach(p => {
      if (!ids.includes(p.id)) return;
      p.colors.forEach(c => c.sizes.forEach(s => {
        const isLow = s.stock > 0 && s.stock <= effectiveThresholdForProduct(p);
        const isOut = s.stock === 0;
        const isSize = scope === 'size' && s.eu === size;
        if (scope === 'all' || (scope === 'low' && isLow) || (scope === 'out' && isOut) || isSize) {
          s.stock = clampNum(s.stock + qtyInt, 0, 9999);
        }
      }));
    });
    saveAll();
    qs('#bulkRestockModal').close();
    renderAll();
  }

  function bulkArchive() {
    const ids = Array.from(state.ui.selectedProductIds);
    if (!ids.length) { alert('Select products first'); return; }
    const names = state.products.filter(p => ids.includes(p.id)).map(p => `${p.brand} ${p.model}`);
    const msg = `Archive ${ids.length} product(s)?\nArchived products are hidden from active listings.`;
    if (!confirm(msg)) { return; }
    state.products.forEach(p => { if (ids.includes(p.id)) p.status = 'archived'; });
    saveAll(); renderProductsTable();
  }

  function bulkUnarchive() {
    const ids = Array.from(state.ui.selectedProductIds);
    if (!ids.length) { alert('Select products first'); return; }
    state.products.forEach(p => { if (ids.includes(p.id)) p.status = 'active'; });
    saveAll(); renderProductsTable();
  }

  // Sales tracking
  function populateSaleSelectors() {
    const prodSel = qs('#saleProduct');
    if (!prodSel) return; // sales controls not present in this layout
    prodSel.innerHTML = state.products.map(p => `<option value="${p.id}">${p.brand} ${p.model}</option>`).join('');
    onSaleProductChange();
  }

  function onSaleProductChange() {
    const prodSel = qs('#saleProduct');
    const colorSel = qs('#saleColor');
    const sizeSel = qs('#saleSize');
    if (!prodSel || !colorSel || !sizeSel) return;
    const p = state.products.find(x => x.id === prodSel.value);
    if (!p) { colorSel.innerHTML = ''; sizeSel.innerHTML = ''; return; }
    colorSel.innerHTML = (p.colors || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const c = p.colors && p.colors[0];
    sizeSel.innerHTML = (c ? c.sizes : EU_SIZES.map(eu => ({ eu }))).map(s => `<option value="${s.eu}">${s.eu}EU</option>`).join('');
  }

  function onSaleColorChange() {
    const prodSel = qs('#saleProduct'); const colorSel = qs('#saleColor'); const sizeSel = qs('#saleSize');
    if (!prodSel || !colorSel || !sizeSel) return;
    const p = state.products.find(x => x.id === prodSel.value);
    if (!p) { sizeSel.innerHTML = ''; return; }
    const c = (p.colors || []).find(y => y.id === colorSel.value);
    if (!c) { sizeSel.innerHTML = ''; return; }
    sizeSel.innerHTML = (c.sizes || []).map(s => `<option value="${s.eu}">${s.eu}EU (${s.stock})</option>`).join('');
  }

  function recordSale() {
    const p = state.products.find(x => x.id === qs('#saleProduct').value);
    const c = p.colors.find(y => y.id === qs('#saleColor').value);
    const eu = parseNum(qs('#saleSize').value);
    const qty = clampNum(parseNum(qs('#saleQty').value, 1), 1, 9999);
  const price = parseNum(qs('#salePrice').value, parseNum(p.pricing?.sale, 0) || parseNum(p.pricing?.original, 0));
    const s = c.sizes.find(z => z.eu === eu);
    if (s.stock < qty) { alert('Insufficient stock'); return; }
    s.stock -= qty;
    const sale = { id: uid('sale'), productId: p.id, colorId: c.id, eu, qty, price, date: new Date().toISOString() };
    state.sales.push(sale);
    saveAll();
    renderSalesLog();
    renderProductsTable();
    if (firebaseState.enabled) upsertSaleToFirestore(sale);
  }

  function renderSalesLog() {
    const tbody = qs('#salesTbody');
    if (!tbody) return;
    const rows = state.sales.slice().reverse().map(sale => {
      const p = state.products.find(p => p.id === sale.productId) || { brand: '?', model: '?' };
      const c = (p.colors && Array.isArray(p.colors)) ? (p.colors.find(x => x.id === sale.colorId) || { name: '?' }) : { name: '?' };
      const total = (parseNum(sale.qty,0) || 0) * (parseNum(sale.price,0) || 0);
      const date = sale.date ? new Date(sale.date).toLocaleString() : '';
      return `<tr>
        <td>${date}</td>
        <td>${p.brand || '?'}</td>
        <td>${p.model || '?'}</td>
        <td>${c.name || '?'}</td>
        <td>${sale.eu || ''}EU</td>
        <td>${sale.qty || 0}</td>
        <td>₱${Number(total || 0).toFixed(2)}</td>
      </tr>`;
    }).join('');
    tbody.innerHTML = rows;
  }

  // Reports & Alerts
  function renderReports() {
    const overview = qs('#overviewList');
    const lowList = qs('#lowStockList');
    const bestSizes = qs('#bestSizesList');
    const bestBrands = qs('#bestBrandsList');
    const deadStock = qs('#deadStockList');
    const lowSummary = qs('#lowStockSummary');
    const sizesSummary = qs('#bestSizesSummary');
    const brandsSummary = qs('#bestBrandsSummary');
    const deadSummary = qs('#deadStockSummary');
    const threshold = state.settings.lowStockThreshold;

    // Timeframe filter for sales
    const tf = state.ui.reports.timeframe || 'all';
    const now = Date.now();
    const cutoff = tf === '7d' ? now - 7*24*3600*1000 : tf === '30d' ? now - 30*24*3600*1000 : 0;
    const salesFiltered = cutoff ? state.sales.filter(s => new Date(s.date).getTime() >= cutoff) : state.sales.slice();

    const activeProducts = state.products.filter(p => p.status === 'active').length;
    const totalUnits = state.products.reduce((acc, p) => acc + totalStockForProduct(p), 0);
    const totalSales = salesFiltered.reduce((acc, s) => acc + (s.qty * s.price), 0);

    overview.innerHTML = [
      `<li><strong>Active products:</strong> ${activeProducts}</li>`,
      `<li><strong>Total units in stock:</strong> ${totalUnits}</li>`,
      `<li><strong>Sales (${tf === 'all' ? 'All Time' : (tf === '7d' ? '7d' : '30d')}):</strong> ₱${totalSales.toFixed(2)}</li>`
    ].join('');

    // Low/out stock summary + optional details
    const lowItems = [];
    let lowCount = 0, outCount = 0;
    state.products.forEach(p => p.colors.forEach(c => c.sizes.forEach(s => {
  if (s.stock === 0) { outCount++; lowItems.push(`<li>${p.brand} ${p.model} - ${c.name} ${s.eu}EU: <span class=\"badge out\">Out</span></li>`); }
  else if (s.stock <= effectiveThresholdForProduct(p)) { lowCount++; lowItems.push(`<li>${p.brand} ${p.model} - ${c.name} ${s.eu}EU: <span class=\"badge low\">Low (${s.stock})</span></li>`); }
    })));
    if (lowSummary) lowSummary.textContent = `Low: ${lowCount} • Out: ${outCount}`;
    const lowOpen = state.ui.reports.open.low;
    const lowShown = lowOpen ? lowItems : lowItems.slice(0, 10);
    lowList.innerHTML = (lowShown.join('') || '<li>All good 👍</li>');
    lowList.classList.toggle('open', lowOpen);
    const lowToggle = document.querySelector('[data-report-toggle="low"]'); if (lowToggle) lowToggle.textContent = lowOpen ? 'Hide details' : 'Show details';

    // Best sizes (timeframe)
    const bySize = new Map();
    salesFiltered.forEach(s => bySize.set(s.eu, (bySize.get(s.eu) || 0) + s.qty));
    const sizeSorted = Array.from(bySize.entries()).sort((a,b) => b[1]-a[1]);
    if (sizesSummary) sizesSummary.textContent = sizeSorted.length ? `Top 5: ${sizeSorted.slice(0,5).map(([eu]) => `${eu}EU`).join(', ')}` : 'No sales yet';
    const sizesOpen = state.ui.reports.open.sizes;
    const sizesShown = (sizesOpen ? sizeSorted : sizeSorted.slice(0,5)).map(([eu, qty]) => `<li>${eu}EU: ${qty} sold</li>`);
    bestSizes.innerHTML = sizesShown.join('') || '<li>No sales yet</li>';
    bestSizes.classList.toggle('open', sizesOpen);
    const sizesToggle = document.querySelector('[data-report-toggle="sizes"]'); if (sizesToggle) sizesToggle.textContent = sizesOpen ? 'Hide details' : 'Show details';

    // Best brands (timeframe)
    const byBrand = new Map();
    salesFiltered.forEach(s => {
      const p = state.products.find(x => x.id === s.productId);
      if (!p) return;
      byBrand.set(p.brand, (byBrand.get(p.brand) || 0) + (s.qty * s.price));
    });
    const brandSorted = Array.from(byBrand.entries()).sort((a,b) => b[1]-a[1]);
    if (brandsSummary) brandsSummary.textContent = brandSorted.length ? `Top 5: ${brandSorted.slice(0,5).map(([brand]) => brand).join(', ')}` : 'No sales yet';
    const brandsOpen = state.ui.reports.open.brands;
    const brandsShown = (brandsOpen ? brandSorted : brandSorted.slice(0,5)).map(([brand, rev]) => `<li>${brand}: ₱${rev.toFixed(2)}</li>`);
    bestBrands.innerHTML = brandsShown.join('') || '<li>No sales yet</li>';
    bestBrands.classList.toggle('open', brandsOpen);
    const brandsToggle = document.querySelector('[data-report-toggle="brands"]'); if (brandsToggle) brandsToggle.textContent = brandsOpen ? 'Hide details' : 'Show details';

    // Dead stock (no sales ever for that product/color/size)
    const soldKey = new Set(state.sales.map(s => `${s.productId}|${s.colorId}|${s.eu}`));
    const deadItems = [];
    state.products.forEach(p => p.colors.forEach(c => c.sizes.forEach(s => {
      const key = `${p.id}|${c.id}|${s.eu}`;
      if (s.stock > 0 && !soldKey.has(key)) {
        deadItems.push(`<li>${p.brand} ${p.model} - ${c.name} ${s.eu}EU (${s.stock} in stock)</li>`);
      }
    })));
    if (deadSummary) deadSummary.textContent = `Items: ${deadItems.length}`;
    const deadOpen = state.ui.reports.open.dead;
    const deadShown = deadOpen ? deadItems : deadItems.slice(0, 10);
    deadStock.innerHTML = deadShown.join('') || '<li>No dead stock 🎉</li>';
    deadStock.classList.toggle('open', deadOpen);
    const deadToggle = document.querySelector('[data-report-toggle="dead"]'); if (deadToggle) deadToggle.textContent = deadOpen ? 'Hide details' : 'Show details';
  }

  function renderAlerts() {
    const ul = qs('#alertsList');
    const threshold = state.settings.lowStockThreshold;
    const alerts = [];
    state.products.forEach(p => p.colors.forEach(c => c.sizes.forEach(s => {
      if (s.stock === 0) alerts.push(`<li>Out of stock: ${p.brand} ${p.model} - ${c.name} ${s.eu}EU</li>`);
      else if (s.stock <= effectiveThresholdForProduct(p)) alerts.push(`<li>Low stock: ${p.brand} ${p.model} - ${c.name} ${s.eu}EU (${s.stock})</li>`);
    })));
    ul.innerHTML = alerts.join('') || '<li>No alerts</li>';
  }

  // Settings
  function renderSettings() { qs('#lowStockThreshold').value = state.settings.lowStockThreshold; }
  function saveSettings() { state.settings.lowStockThreshold = clampNum(parseNum(qs('#lowStockThreshold').value, 3), 1, 999); saveAll(); renderAll(); }

  // (Publish-to-storefront removed: storefront now reads directly from Firestore `products`.)

  // Render all
  function renderAll() {
    populateFilters();
    renderProductsTable();
    if (state.ui.selectedTab === 'sales') { populateSaleSelectors(); renderSalesLog(); }
    if (state.ui.selectedTab === 'reports') renderReports();
    if (state.ui.selectedTab === 'alerts') renderAlerts();
    if (state.ui.selectedTab === 'settings') renderSettings();
  }

  // Export inventory to a Word-compatible .doc file (HTML document saved with .doc extension)
  function escapeHtml(str){
    return (str===undefined || str===null) ? '' : String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function exportInventoryAsWord(){
    try{
      const rows = [];
      state.products.forEach(p => {
        const colorsArr = Array.isArray(p.colors) ? p.colors : [];
        (colorsArr||[]).forEach(c => {
          const sizesMap = {};
          (Array.isArray(c.sizes)?c.sizes:[]).forEach(s => { sizesMap[String(s.eu)] = Number(s.stock||0); });
          const total = Object.values(sizesMap).reduce((a,b)=>a+Number(b||0),0);
          const threshold = effectiveThresholdForProduct(p);
          // find sizes that meet or fall below the threshold (inclusive)
          const lowSizes = Object.keys(sizesMap).filter(k => Number(sizesMap[k]) <= Number(threshold));
          const low = (lowSizes.length > 0) || (total <= Number(threshold));
          rows.push({ brand: p.brand||'', model: p.model||'', sku: p.sku||'', color: c.name||'', sizes: sizesMap, total: total, threshold: threshold, low: low, lowSizes: lowSizes });
        });
        if(!Array.isArray(p.colors) || p.colors.length===0){
          const sizesMap = {};
          const total = 0;
          const threshold = effectiveThresholdForProduct(p);
          rows.push({ brand: p.brand||'', model: p.model||'', sku: p.sku||'', color: '', sizes: sizesMap, total: total, threshold: threshold, low: false });
        }
      });

      const now = new Date();
      const title = `Inventory Export - ${now.toLocaleString()}`;
      let html = '<!doctype html><html><head><meta charset="utf-8"><title>'+escapeHtml(title)+'</title>' +
                 '<style>body{font-family:Arial,Helvetica,sans-serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f6f6f6} .low{color:#b71c1c;font-weight:700}</style></head><body>';
      html += '<h1>'+escapeHtml(title)+'</h1>';
      html += '<table><thead><tr><th>Brand</th><th>Model</th><th>SKU</th><th>Color</th><th>Sizes</th><th>Total</th><th>Critical Level</th><th>Low Sizes</th><th>Status</th></tr></thead><tbody>';
      rows.forEach(r => {
        const sizesText = Object.keys(r.sizes).length ? Object.keys(r.sizes).map(k => escapeHtml(k) + ': ' + escapeHtml(String(r.sizes[k]))).join(', ') : '';
        const lowSizesText = (r.lowSizes && r.lowSizes.length) ? escapeHtml(r.lowSizes.join(', ')) : '';
        const status = r.low ? '<span class="low">LOW STOCK</span>' : 'OK';
        html += '<tr>' +
                '<td>' + escapeHtml(r.brand) + '</td>' +
                '<td>' + escapeHtml(r.model) + '</td>' +
                '<td>' + escapeHtml(r.sku) + '</td>' +
                '<td>' + escapeHtml(r.color) + '</td>' +
                '<td>' + sizesText + '</td>' +
                '<td>' + escapeHtml(String(r.total)) + '</td>' +
                '<td>' + escapeHtml(String(r.threshold)) + '</td>' +
                '<td>' + lowSizesText + '</td>' +
                '<td>' + status + '</td>' +
                '</tr>';
      });
      html += '</tbody></table></body></html>';

      const blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
      const filename = 'inventory-export-' + now.toISOString().slice(0,19).replace(/[:T]/g,'-') + '.doc';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1500);
    }catch(e){ console.error(e); alert('Failed to export inventory. See console for details.'); }
  }

  // Event wiring
  function wireEvents() {
  qsa('.tabs button').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  const addProductBtn = qs('#addProductBtn'); if (addProductBtn) addProductBtn.addEventListener('click', () => { window.location.href = 'add-product.html'; });
  const saveProductBtn = qs('#saveProductBtn'); if (saveProductBtn) saveProductBtn.addEventListener('click', (e) => { e.preventDefault(); saveProductFromModal(); });
  const cancelBtn = qs('#cancelProductBtn'); if (cancelBtn) cancelBtn.addEventListener('click', (e) => { e.preventDefault(); qs('#productModal').close(); });
  const addInitBtn = qs('#addInitialColorBtn'); if (addInitBtn) addInitBtn.addEventListener('click', (e) => { e.preventDefault(); addInitialColorFromModal(); });
  const importImageBtn = qs('#importImageBtn'); if (importImageBtn) importImageBtn.addEventListener('click', (e) => { e.preventDefault(); addImagesFromFileInput(); });

  const addColorBtn = qs('#addColorBtn'); if (addColorBtn) addColorBtn.addEventListener('click', (e) => { e.preventDefault(); addColorFromModal(); });
  const saveVariantsBtn = qs('#saveVariantsBtn'); if (saveVariantsBtn) saveVariantsBtn.addEventListener('click', (e) => { e.preventDefault(); saveVariantsModal(); });

  const toggleBulkSelect = qs('#toggleBulkSelect'); if (toggleBulkSelect) toggleBulkSelect.addEventListener('change', (e) => setBulkMode(e.target.checked));
  const bulkEditPriceBtn = qs('#bulkEditPrice'); if (bulkEditPriceBtn) bulkEditPriceBtn.addEventListener('click', openBulkPrice);
  const applyBulkPriceBtn = qs('#applyBulkPriceBtn'); if (applyBulkPriceBtn) applyBulkPriceBtn.addEventListener('click', (e) => { e.preventDefault(); applyBulkPrice(); });

  const bulkRestockBtn = qs('#bulkRestock'); if (bulkRestockBtn) bulkRestockBtn.addEventListener('click', openBulkRestock);
  const applyBulkRestockBtn = qs('#applyBulkRestockBtn'); if (applyBulkRestockBtn) applyBulkRestockBtn.addEventListener('click', (e) => { e.preventDefault(); applyBulkRestock(); });
  const exportBtn = qs('#exportInventoryBtn'); if (exportBtn) exportBtn.addEventListener('click', (e) => { e.preventDefault(); exportInventoryAsWord(); });
    const bulkPriceMethodSel = qs('#bulkPriceMethod');
    const bulkPriceValueInp = qs('#bulkPriceValue');
    if (bulkPriceMethodSel && bulkPriceValueInp) {
      const updatePlaceholder = () => {
        const m = bulkPriceMethodSel.value;
        if (m === 'inc_pct' || m === 'dec_pct') bulkPriceValueInp.placeholder = 'Percent (e.g., 10)';
        else bulkPriceValueInp.placeholder = 'Amount or value (e.g., 100)';
      };
      bulkPriceMethodSel.addEventListener('change', updatePlaceholder);
      updatePlaceholder();
    }

  const bulkArchiveBtn = qs('#bulkArchive'); if (bulkArchiveBtn) bulkArchiveBtn.addEventListener('click', bulkArchive);
  const bulkUnarchiveBtn = qs('#bulkUnarchive'); if (bulkUnarchiveBtn) bulkUnarchiveBtn.addEventListener('click', bulkUnarchive);

    const scopeSel = qs('#bulkRestockScope');
    const sizeInp = qs('#bulkRestockSize');
    if (scopeSel && sizeInp) {
      const toggleSize = () => { sizeInp.style.display = scopeSel.value === 'size' ? 'block' : 'none'; };
      scopeSel.addEventListener('change', toggleSize);
      toggleSize();
    }

    const selectAllBtn = qs('#selectAllBtn');
    if (selectAllBtn) selectAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.ui.bulkMode) { alert('Enable Bulk select first'); return; }
      qsa('.bulkSel').forEach(cb => { cb.checked = true; state.ui.selectedProductIds.add(cb.dataset.id); });
      updateSelectedCount();
    });

  // Sales
  const saleProductEl = qs('#saleProduct'); if (saleProductEl) saleProductEl.addEventListener('change', onSaleProductChange);
  const saleColorEl = qs('#saleColor'); if (saleColorEl) saleColorEl.addEventListener('change', onSaleColorChange);
  const recordSaleBtn = qs('#recordSaleBtn'); if (recordSaleBtn) recordSaleBtn.addEventListener('click', recordSale);

    // Filters - listen for both `input` and `change` so select elements reliably
    // trigger a refresh across browsers when the value changes.
    ['#searchInput','#filterBrand','#filterCategory','#filterSize','#filterStock','#filterStatus'].forEach(sel => {
      const el = qs(sel);
      if (!el) return;
      el.addEventListener('input', renderProductsTable);
      el.addEventListener('change', renderProductsTable);
    });

    // Reports controls and toggles
    const tfSel = qs('#reportsTimeframe');
    if (tfSel) tfSel.addEventListener('change', () => { state.ui.reports.timeframe = tfSel.value; renderReports(); });
    qsa('[data-report-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.reportToggle;
      const open = state.ui.reports.open[key];
      state.ui.reports.open[key] = !open;
      btn.textContent = open ? 'Show details' : 'Hide details';
      renderReports();
    }));
    // Settings
    const saveSettingsBtn = qs('#saveSettingsBtn'); if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);
  }

  // Init
  function init() {
    loadAll();
  // Sample seeding removed to avoid demo rows appearing on load.
    backfillSkus();
    backfillSizeSkus();
    backfillCreatedAt();
    backfillCategoryAndStatus();
    wireEvents();
    // Load persisted settings from localStorage so other pages (e.g. dashboard)
    // can read the canonical low-stock threshold. Persist settings when the
    // user clicks Save Settings below.
    try {
      var saved = localStorage.getItem('inventory_app_settings');
      if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed && parsed.lowStockThreshold) {
          state.settings = state.settings || {};
          state.settings.lowStockThreshold = Number(parsed.lowStockThreshold) || state.settings.lowStockThreshold || 3;
        }
      }
    } catch (e) { /* ignore malformed saved settings */ }

    try {
      var saveBtn = document.getElementById('saveSettingsBtn');
      if (saveBtn) {
        saveBtn.addEventListener('click', function(){
          try {
            // persist minimal settings shape
            var toSave = { lowStockThreshold: (state && state.settings && state.settings.lowStockThreshold) ? state.settings.lowStockThreshold : 3 };
            localStorage.setItem('inventory_app_settings', JSON.stringify(toSave));
            // also expose for debug/other pages
            try { window.lastInvSettings = toSave; } catch(_) {}
          } catch (e) { /* ignore storage errors */ }
        });
      }
    } catch (e) {}
    // Auto-save lowStockThreshold when the user changes the input so other pages (dashboard)
    // pick up the canonical value immediately.
    try {
      var thresholdInput = document.getElementById('lowStockThreshold');
      if (thresholdInput) {
        // initialize input value from loaded settings
        try { thresholdInput.value = (state && state.settings && state.settings.lowStockThreshold) ? Number(state.settings.lowStockThreshold) : thresholdInput.value || 3; } catch(e){}

        var persistThreshold = function(){
          try {
            var v = parseNum(thresholdInput.value, NaN);
            if (!Number.isFinite(v) || v < 1) v = 1;
            state.settings = state.settings || {};
            state.settings.lowStockThreshold = Math.floor(v);
            var toSave = { lowStockThreshold: state.settings.lowStockThreshold };
            localStorage.setItem('inventory_app_settings', JSON.stringify(toSave));
            try { window.lastInvSettings = toSave; } catch(_) {}
            // refresh reports and table so UI reflects new threshold immediately
            try { renderReports(); } catch(e){}
            try { renderProductsTable(); } catch(e){}
          } catch (e) { /* ignore */ }
        };
        thresholdInput.addEventListener('input', persistThreshold);
        thresholdInput.addEventListener('change', persistThreshold);
      }
    } catch (e) {}
    // Initialize Firebase (if configured) and attach realtime listeners
    try { initFirebase(); } catch (e) { /* ignore */ }
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
