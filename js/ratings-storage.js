(function(){
  const STORAGE_KEY = 'productRatings_v1';

  function safeJsonParse(text, fallback){
    try{ return JSON.parse(text); }catch(e){ return fallback; }
  }

  function getStore(){
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = safeJsonParse(raw || '{}', {});
    return (obj && typeof obj === 'object') ? obj : {};
  }

  function setStore(store){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store || {}));
  }

  function normalizeKeyPart(v){
    return String(v || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g,' ')
      .replace(/[^a-z0-9 _\-:]/g,'');
  }

  function getActiveProfile(){
    try{ return safeJsonParse(localStorage.getItem('profile')||'null', null); }catch(e){ return null; }
  }

  function getProductKey(input){
    input = input || {};
    const explicit = input.productKey || input.key;
    if(explicit) return String(explicit);

    const id = input.productId || input.id;
    if(id && String(id).trim()) return 'id:' + String(id).trim();

    const brand = normalizeKeyPart(input.brand);
    const title = normalizeKeyPart(input.title || input.name);
    if(brand || title) return 'bt:' + brand + '|' + title;

    return 'unknown';
  }

  function sanitizeStars(stars){
    const s = Number(stars);
    if(!isFinite(s)) return 0;
    return Math.max(1, Math.min(5, Math.round(s)));
  }

  function addOrUpdateRating(payload){
    payload = payload || {};
    const productKey = getProductKey(payload);
    const stars = sanitizeStars(payload.stars);
    const comment = String(payload.comment || '').trim();

    if(!stars) throw new Error('stars_required');

    const profile = getActiveProfile();
    const userEmail = String(payload.userEmail || (profile && profile.email) || '').trim().toLowerCase();
    const userName = String(payload.userName || (profile && (profile.name || profile.fullName)) || '').trim();
    const orderId = String(payload.orderId || '').trim();

    const store = getStore();
    const list = Array.isArray(store[productKey]) ? store[productKey] : [];

    const nowIso = new Date().toISOString();
    const entry = {
      stars: stars,
      comment: comment,
      createdAt: nowIso,
      orderId: orderId || undefined,
      userEmail: userEmail || undefined,
      userName: userName || undefined,
      productId: payload.productId || payload.id || undefined,
      brand: payload.brand || undefined,
      title: payload.title || payload.name || undefined
    };

    // Idempotent update: if same user rated same product for same order, replace it.
    let replaced = false;
    if(orderId && userEmail){
      for(let i=0;i<list.length;i++){
        const r = list[i] || {};
        if(String(r.orderId||'') === orderId && String(r.userEmail||'').toLowerCase() === userEmail){
          list[i] = Object.assign({}, r, entry, { createdAt: nowIso });
          replaced = true;
          break;
        }
      }
    }
    if(!replaced) list.unshift(entry);

    store[productKey] = list;
    setStore(store);

    try{
      window.dispatchEvent(new CustomEvent('ratings:updated', { detail: { productKey: productKey } }));
    }catch(e){
      try{ window.dispatchEvent(new Event('ratings:updated')); }catch(_){ }
    }

    return entry;
  }

  function getRatings(productKeyOrInput){
    const key = (typeof productKeyOrInput === 'string') ? productKeyOrInput : getProductKey(productKeyOrInput);
    const store = getStore();
    const list = Array.isArray(store[key]) ? store[key] : [];
    return list.slice();
  }

  function getSummary(productKeyOrInput){
    const list = getRatings(productKeyOrInput);
    if(!list.length) return { avg: 0, count: 0, breakdown: { 1:0,2:0,3:0,4:0,5:0 } };

    let sum = 0;
    const breakdown = { 1:0,2:0,3:0,4:0,5:0 };
    list.forEach(r => {
      const s = sanitizeStars(r && r.stars);
      sum += s;
      breakdown[s] = (breakdown[s] || 0) + 1;
    });

    return { avg: sum / list.length, count: list.length, breakdown: breakdown };
  }

  function starsText(n){
    const s = sanitizeStars(n);
    return '★★★★★'.slice(0,s) + '☆☆☆☆☆'.slice(0,5-s);
  }

  window.ShoePaoRatings = {
    storageKey: STORAGE_KEY,
    getProductKey: getProductKey,
    addOrUpdateRating: addOrUpdateRating,
    getRatings: getRatings,
    getSummary: getSummary,
    starsText: starsText
  };
})();
