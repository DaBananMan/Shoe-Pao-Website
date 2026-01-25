// cart-storage.js
// Universal cart storage logic for all pages

// Restore auth token for pages that rely on window.AUTH_TOKEN
try{
    if(typeof window !== 'undefined' && !window.AUTH_TOKEN){
        var _t = localStorage.getItem('authToken');
        if(_t) window.AUTH_TOKEN = _t;
    }
}catch(e){}

function getCart() {
    return JSON.parse(localStorage.getItem('cart') || '[]');
}

var MAX_PAIRS_PER_ORDER = 3;

// In-memory inventory rows cache (from Firestore products/variants)
var __inventoryRowsCache = [];
var __inventoryRowsLoaded = false;
var __inventoryRowsLoading = false;

function refreshInventoryRowsCache(){
    try{
        if(__inventoryRowsLoading) return;
        if(!(window.FIREBASE_CONFIG && window.firebase && firebase.firestore)) return;
        if(!firebase.apps || !firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        __inventoryRowsLoading = true;
        var db = firebase.firestore();
        Promise.all([db.collection('products').get(), db.collection('variants').get()])
            .then(function(res){
                var products = [];
                res[0].forEach(function(doc){ products.push(Object.assign({ id: doc.id }, doc.data() || {})); });
                var variants = [];
                res[1].forEach(function(doc){ variants.push(Object.assign({ id: doc.id }, doc.data() || {})); });
                var map = {};
                variants.forEach(function(v){
                    var pid = v.productId || v.product_id || (v.product && (v.product.id || v.productId)) || (v.productRef && v.productRef.id) || (v.product_ref && v.product_ref.id) || null;
                    if(!pid) return;
                    map[pid] = map[pid] || [];
                    map[pid].push({
                        id: v.id || ('color-' + Math.random().toString(36).slice(2,9)),
                        name: v.colorName || v.name || v.color || 'Color',
                        code: v.colorCode || v.code || '#ffffff',
                        sizes: Array.isArray(v.sizes) ? v.sizes : []
                    });
                });
                __inventoryRowsCache = [];
                products.forEach(function(p){
                    var pid = p.id || p.productId || p.sku || '';
                    var colorsArr = Array.isArray(p.colors) && p.colors.length ? p.colors : (map[pid] || []);
                    var baseImg = (Array.isArray(p.images) && p.images.length) ? p.images[0] : (p.image || '');
                    (colorsArr || []).forEach(function(c){
                        var sizesMap = {};
                        (Array.isArray(c.sizes) ? c.sizes : []).forEach(function(s){ if(s && s.eu !== undefined){ sizesMap[String(s.eu)] = Number(s.stock||0)||0; } });
                        __inventoryRowsCache.push({
                            id: (p.sku || p.id || '') + ':' + (c.id || c.name || ''),
                            productId: p.id || '',
                            name: (p.model || p.name || '') + (c.name ? (' ' + c.name) : ''),
                            brand: p.brand || '',
                            color: c.name || '',
                            image: baseImg || '',
                            sizes: sizesMap,
                            price: Number((p.pricing && (p.pricing.sale || p.pricing.original)) || p.price || 0),
                            originalPrice: Number((p.pricing && p.pricing.original) || p.originalPrice || 0),
                            gender: p.gender || ''
                        });
                    });
                });
                __inventoryRowsLoaded = true;
                __inventoryRowsLoading = false;
            })
            .catch(function(){ __inventoryRowsLoading = false; });
    }catch(e){ __inventoryRowsLoading = false; }
}

function getInventoryRowsCache(){
    if(!__inventoryRowsLoaded && !__inventoryRowsLoading){ refreshInventoryRowsCache(); }
    return Array.isArray(__inventoryRowsCache) ? __inventoryRowsCache : [];
}

function getCartTotalPairs(cart){
    try{
        cart = Array.isArray(cart) ? cart : getCart();
        var total = 0;
        cart.forEach(function(item){
            var qty = (typeof item.qty === 'number') ? item.qty : ((typeof item.quantity === 'number') ? item.quantity : 1);
            total += Number(qty) || 0;
        });
        return total;
    }catch(e){ return 0; }
}

function showMaxPairsMessage(){
    try{ alert('Maximum of 3 pairs of shoes per order.'); }catch(e){}
}

function canAddPairs(cart, addQty){
    try{
        var total = getCartTotalPairs(cart);
        var inc = Number(addQty || 0) || 0;
        return (total + inc) <= MAX_PAIRS_PER_ORDER;
    }catch(e){ return false; }
}

function tryIncrementCartItem(cart, idx){
    try{
        cart = Array.isArray(cart) ? cart : getCart();
        if(!cart[idx]) return { success:false, reason:'invalid_index' };
        try{
            var item = cart[idx];
            var current = (typeof item.qty === 'number') ? item.qty : (typeof item.quantity === 'number' ? item.quantity : 1);
            var maxAllowed = (window.getMaxAllowedForProduct && typeof window.getMaxAllowedForProduct === 'function') ? window.getMaxAllowedForProduct(item) : Number.POSITIVE_INFINITY;
            if(Number.isFinite(maxAllowed) && current >= maxAllowed){
                return { success:false, reason:'max_reached', maxAllowed: maxAllowed };
            }
        }catch(e){}
        if(!canAddPairs(cart, 1)) return { success:false, reason:'max_pairs' };
        if(typeof cart[idx].qty === 'number') cart[idx].qty++;
        else if(typeof cart[idx].quantity === 'number') cart[idx].quantity++;
        else cart[idx].qty = (cart[idx].qty || cart[idx].quantity || 1) + 1;
        return { success:true };
    }catch(e){ return { success:false, reason:'error' }; }
}

function tryDecrementCartItem(cart, idx){
    try{
        cart = Array.isArray(cart) ? cart : getCart();
        if(!cart[idx]) return { success:false, reason:'invalid_index' };
        if(typeof cart[idx].qty === 'number') { if(cart[idx].qty > 1) cart[idx].qty--; }
        else if(typeof cart[idx].quantity === 'number') { if(cart[idx].quantity > 1) cart[idx].quantity--; }
        return { success:true };
    }catch(e){ return { success:false, reason:'error' }; }
}

function saveCart(cart) {
    try{
        if(Array.isArray(cart) && cart.length === 0){
            // Helpful debug logging: detect unexpected clears
            try{ console.warn('Saving empty cart to localStorage', new Error().stack); }catch(_){ }
        }
    }catch(_){ }
    localStorage.setItem('cart', JSON.stringify(cart));
    try{
        localStorage.setItem('checkoutCartSnapshot', JSON.stringify(Array.isArray(cart) ? cart : []));
    }catch(e){}
    try{ window.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart: Array.isArray(cart) ? cart : [] } })); }catch(e){}
}

function addToCart(product) {
    // Require user to be signed in before adding to cart.
    try {
    // Prefer Firebase auth when available. If Firebase exists and reports no currentUser,
    // require login. If Firebase is not available for some reason, fall back to the
    // legacy localStorage "profile" check (but log a warning).
    try{
        if(window.firebase && firebase.auth){
            var fbUser = firebase.auth().currentUser;
            if(!fbUser){
                try{ var returnUrl = window.location.pathname + window.location.search; }catch(e){ var returnUrl = '' }
                var redirect = 'login.html'; if(returnUrl) redirect += '?return=' + encodeURIComponent(returnUrl);
                try{ alert('Please sign in to add items to your cart. You will be redirected to the login page.'); }catch(e){}
                window.location.href = redirect;
                return { success: false, reason: 'login_required' };
            }
        } else {
            // firebase not present on this page — fall back to localStorage profile (legacy behavior)
            var profile = null; try{ profile = JSON.parse(localStorage.getItem('profile')||'null'); }catch(e){ profile = null; }
            if(!profile || !profile.email){
                try{ var returnUrl = window.location.pathname + window.location.search; }catch(e){ var returnUrl = '' }
                var redirect = 'login.html'; if(returnUrl) redirect += '?return=' + encodeURIComponent(returnUrl);
                try{ alert('Please sign in to add items to your cart. You will be redirected to the login page.'); }catch(e){}
                window.location.href = redirect;
                return { success: false, reason: 'login_required' };
            }
        }
    }catch(e){ /* ignore auth check errors, continue to attempt adding */ }
    }catch(e){ /* ignore auth check errors, continue to attempt adding */ }
    // Enforce inventory-aware caps before adding
    try {
        var cart = getCart();
        var maxAllowed = getMaxAllowedForProduct(product);
        var incomingQty = product.qty || product.quantity || 1;
        if (!canAddPairs(cart, incomingQty)) {
            return { success: false, reason: 'max_pairs', maxPairs: MAX_PAIRS_PER_ORDER };
        }
        // If product stock is 0 and not marked pre-order, don't add
        if (maxAllowed === 0 && !product.preOrder) {
            return { success: false, reason: 'out_of_stock' };
        }
        // Prevent duplicates by title+brand+size (if size exists).
        // Attempt to attach a deterministic inventory identifier to the cart item so
        // later editors can match exactly instead of relying on fuzzy name matching.
        try{ var invMatchForIncoming = findInventoryItemForProduct(product); if(invMatchForIncoming && invMatchForIncoming.id) product.inventoryId = invMatchForIncoming.id; 
            // Derive variantId using size mapping from storefront inventory
            try{
                if(!product.variantId){
                    var vId = getVariantIdForProduct(product, invMatchForIncoming);
                    if(vId) product.variantId = vId;
                }
            }catch(_){ }
            // Also copy over a canonical color/image from inventory when available so
            // cart items carry the visual identity they had when added. This helps the
            // cart editor prefer the correct color via image-filename matching.
            try{ if(invMatchForIncoming){ if(!product.color && (invMatchForIncoming.color || invMatchForIncoming.colorName)) product.color = invMatchForIncoming.color || invMatchForIncoming.colorName; if(!product.image && (invMatchForIncoming.image || (invMatchForIncoming.images && invMatchForIncoming.images[0]))) product.image = invMatchForIncoming.image || (invMatchForIncoming.images && invMatchForIncoming.images[0]); } }catch(_){ }
        }catch(e){}
        // Match only when both the identifying variant (inventoryId) AND size match,
        // or when title+brand+size match for legacy items. This prevents different sizes
        // of the same variant from being merged into one line.
        let found = cart.find(function(item){
            try{
                var itemSize = (item.size === undefined || item.size === null) ? '' : String(item.size).trim();
                var prodSize = (product.size === undefined || product.size === null) ? '' : String(product.size).trim();
                if(item.inventoryId && product.inventoryId && String(item.inventoryId) === String(product.inventoryId)){
                    return itemSize === prodSize;
                }
                return item.title === product.title && item.brand === product.brand && itemSize === prodSize;
            }catch(e){ return false; }
        });
        if (found) {
            var current = (found.qty || found.quantity || 1);
            var incoming = incomingQty;
            var newQty = current + incoming;
            var totalPairs = getCartTotalPairs(cart);
            var totalIfAdded = totalPairs - current + newQty;
            if (totalIfAdded > MAX_PAIRS_PER_ORDER) {
                return { success: false, reason: 'max_pairs', maxPairs: MAX_PAIRS_PER_ORDER };
            }
            if (newQty > maxAllowed) {
                found.qty = maxAllowed;
                saveCart(cart);
                return { success: false, reason: 'max_reached', maxAllowed: maxAllowed };
            } else {
                found.qty = newQty;
                // preserve preOrder flag if either existing or incoming is pre-order
                if (product.preOrder || found.preOrder) found.preOrder = true;
                // copy over inventoryId if incoming has it but existing doesn't
                try{ if(!found.inventoryId && product.inventoryId) found.inventoryId = product.inventoryId; }catch(e){}
                try{ if(!found.variantId && product.variantId) found.variantId = product.variantId; }catch(e){}
            }
        } else {
            var incoming = incomingQty;
            if (incoming > maxAllowed) product.qty = maxAllowed;
            // Ensure new cart item carries the inventoryId when available
            try{ if(!product.inventoryId){ var _m = findInventoryItemForProduct(product); if(_m && _m.id) product.inventoryId = _m.id; if(!product.variantId){ var _v = getVariantIdForProduct(product, _m); if(_v) product.variantId = _v; } } }catch(e){}
            cart.unshift(product); // Add new/different shoes to the top (stack vertically)
        }
        saveCart(cart);
        return { success: true };
    } catch (e) {
        // fallback: behave like previous implementation if anything goes wrong
        let cart = getCart();
        let found = cart.find(function(item){ try{ var itemSize = (item.size === undefined || item.size === null) ? '' : String(item.size).trim(); var prodSize = (product.size === undefined || product.size === null) ? '' : String(product.size).trim(); if(item.inventoryId && product.inventoryId && String(item.inventoryId) === String(product.inventoryId)) return itemSize === prodSize; return item.title === product.title && item.brand === product.brand && itemSize === prodSize; }catch(e){ return false; } });
        if (found) {
            found.qty = (found.qty || 1) + (product.qty || 1);
        } else {
            cart.unshift(product);
        }
        saveCart(cart);
        return { success: true };
    }
}

// Find inventory item matching a product (by id, name exact, contains title, or brand)
function findInventoryItemForProduct(product) {
    try {
        var inv = getInventoryRowsCache();
        if (!Array.isArray(inv) || inv.length === 0) return null;
        // prefer id match
        if (product.id) {
            var byId = inv.find(function(i){ return i.id === product.id; });
            if (byId) return byId;
        }
        var title = (product.title || '').toString().trim();
        var brand = (product.brand || '').toString().trim();
        var found = inv.find(function(i){ return (i.name||'').toString().trim() === title; });
        if (found) return found;
        found = inv.find(function(i){ return title && (i.name||'').toString().toLowerCase().indexOf(title.toLowerCase()) !== -1; });
        if (found) return found;
        if (brand) {
            found = inv.find(function(i){ return (i.brand||'').toString().toLowerCase() === brand.toLowerCase(); });
            if (found) return found;
        }
        return null;
    } catch (e) { return null; }
}

// Derive a variant id for the given product+inventory using size mapping when available
function getVariantIdForProduct(product, inventoryItem){
    try{
        if(!product || !inventoryItem) return '';
        var size = (product.size === undefined || product.size === null) ? '' : String(product.size).trim();
        if(!size) return '';
        if(inventoryItem.variantIdsBySize && inventoryItem.variantIdsBySize.hasOwnProperty(size)){
            return inventoryItem.variantIdsBySize[size];
        }
        return '';
    }catch(e){ return ''; }
}

// Returns the maximum allowed quantity a customer can have for the given product based on inventory rules
function getMaxAllowedForProduct(product) {
    try {
        var invItem = findInventoryItemForProduct(product);
        // If inventory is missing for this product, allow adding without an artificial cap
        // (the live site may not seed inventory for all visitors). When inventory exists,
        // enforce critical-level rule: if stock < 6 allow only 1 per customer; otherwise
        // allow up to the available stock (no lower cap like '3').
        if (product && product.preOrder === true) {
            // Allow pre-orders up to 3 items by default (can be tuned)
            var cap = Number(product.preOrderMax || 3);
            return (isFinite(cap) && cap > 0) ? cap : 3;
        }
        if (!invItem) {
            return Number.POSITIVE_INFINITY; // no artificial cap
        }
        var size = (product.size || '').toString();
        var stock = (invItem.sizes && (invItem.sizes[size] !== undefined)) ? Number(invItem.sizes[size]) : 0;
        if (isNaN(stock) || stock <= 0) return 0;
        if (stock < 6) return 1; // critical level: only one allowed
        // otherwise allow up to the available stock (no artificial per-customer cap)
        return stock;
    } catch (e) {
        return 3;
    }
}

// Compute packaging fee: every two total shoes in the cart incurs an additional PHP 50 charge
function computePackagingFee(cart) {
    try {
        cart = Array.isArray(cart) ? cart : getCart();
        var totalItems = 0;
        cart.forEach(function(item){
            var qty = (typeof item.qty === 'number') ? item.qty : ((typeof item.quantity === 'number') ? item.quantity : 1);
            totalItems += Number(qty) || 0;
        });
        var pairs = Math.floor(totalItems / 2);
        return pairs * 50; // 50 PHP per pair
    } catch (e) { return 0; }
}

function getCartTotals(cart) {
    try {
        cart = Array.isArray(cart) ? cart : getCart();
        var subtotal = 0;
        cart.forEach(function(item){
            var qty = (typeof item.qty === 'number') ? item.qty : ((typeof item.quantity === 'number') ? item.quantity : 1);
            subtotal += (Number(item.price) || 0) * Number(qty);
        });
        var packaging = computePackagingFee(cart);
        return { subtotal: subtotal, packaging: packaging, total: subtotal + packaging };
    } catch (e) { return { subtotal:0, packaging:0, total:0 }; }

}

// expose helpers globally
window.computePackagingFee = computePackagingFee;
window.getCartTotals = getCartTotals;
window.getCartTotalPairs = getCartTotalPairs;
window.tryIncrementCartItem = tryIncrementCartItem;
window.tryDecrementCartItem = tryDecrementCartItem;
window.showMaxPairsMessage = showMaxPairsMessage;
window.MAX_PAIRS_PER_ORDER = MAX_PAIRS_PER_ORDER;

// Update any cart sidebar UI elements if present on the page.
function renderCartSidebarUI(){
    try{
        var cart = getCart();
        var totals = getCartTotals(cart);
        // format currency simple helper
        function fmt(v){ try{ return new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(v); }catch(e){ return '₱'+Number(v||0).toFixed(2);} }
        // update subtotal
            // Remove/hide the subtotal row in the cart sidebar UI — we'll show a single Total row instead
            try{
                var elSubtotal = document.getElementById('cartSubtotal');
                if(elSubtotal){
                    // hide the entire row containing the subtotal (safest across templates)
                    var subRow = elSubtotal.closest ? elSubtotal.closest('.cart-subtotal-row') : (elSubtotal.parentNode || null);
                    if(subRow) subRow.style.display = 'none';
                }
            }catch(e){}
        // update packaging row/value
        var pkgRow = document.getElementById('cartPackagingRow');
        if(!pkgRow){
            // try to create under subtotal
            if(elSubtotal && elSubtotal.parentNode && elSubtotal.parentNode.parentNode){
                pkgRow = document.createElement('div'); pkgRow.id='cartPackagingRow'; pkgRow.className='cart-subtotal-row'; pkgRow.style.marginTop='6px';
                pkgRow.innerHTML = '<span class="cart-subtotal-label">Packaging Fee</span><span id="cartPackagingValue" class="cart-subtotal-value">₱0.00</span>';
                elSubtotal.parentNode.parentNode.insertBefore(pkgRow, elSubtotal.parentNode.nextSibling);
            }
        }
        // Remove/hide packaging row in cart sidebar UI — packaging is added to J&T shipping and should not show separately here
        try{
            var pkgVal = document.getElementById('cartPackagingValue'); if(pkgVal) pkgVal.textContent = fmt(totals.packaging);
            if(pkgRow) {
                // If the packaging row exists inside the cart sidebar, remove it entirely so it never appears in the cart modal
                var cartSidebar = document.getElementById('cartSidebar');
                if(cartSidebar && cartSidebar.contains(pkgRow)) {
                    pkgRow.remove();
                } else {
                    // otherwise keep it hidden (for non-sidebar contexts)
                    pkgRow.style.display = 'none';
                }
            }
            // Also defensively remove any packaging row that other scripts may have inserted directly inside the cart sidebar
            try{
                var extra = document.querySelectorAll('#cartSidebar #cartPackagingRow');
                extra.forEach(function(n){ if(n) n.remove(); });
            }catch(e){}
        }catch(e){}
        // update total row
            // ensure a single Total row exists in the cart sidebar and update it
            try{
                var totalRow = document.getElementById('cartTotalRow');
                if(!totalRow){
                    // create a Total row under the cart items area
                    var cartSidebar = document.getElementById('cartSidebar');
                    if(cartSidebar){
                        totalRow = document.createElement('div');
                        totalRow.id = 'cartTotalRow';
                        totalRow.className = 'cart-subtotal-row';
                        totalRow.style.marginTop = '6px';
                        totalRow.innerHTML = '<span class="cart-subtotal-label">Total</span><span id="cartTotalValue" class="cart-subtotal-value">' + fmt(0) + '</span>';
                        // insert before the checkout button if available
                        var checkoutBtn = document.getElementById('checkoutBtn');
                        if(checkoutBtn && checkoutBtn.parentNode) checkoutBtn.parentNode.insertBefore(totalRow, checkoutBtn);
                        else cartSidebar.appendChild(totalRow);
                    }
                }
                var totalVal = document.getElementById('cartTotalValue'); if(totalVal) totalVal.textContent = fmt(totals.subtotal);
            }catch(e){}
        // update cart count
        var countEl = document.getElementById('cartCount'); if(countEl){ var totalItems2=0; cart.forEach(function(it){ var q=(typeof it.qty==='number')?it.qty:((typeof it.quantity==='number')?it.quantity:1); totalItems2 += Number(q)||0; }); countEl.textContent = totalItems2; }
    }catch(e){ /* ignore UI update errors */ }
    try{ // ensure the cart item list (with edit buttons) is also updated when UI values change
        renderCartSidebarItems();
    }catch(err){}
}

// Keep cart UI in sync when cart changes in other tabs/windows
window.addEventListener('storage', function(e){ if(e.key === 'cart' || e.key === null) renderCartSidebarUI(); });
// Also try to update when DOM is ready
document.addEventListener('DOMContentLoaded', function(){ renderCartSidebarUI(); });

// When user clicks the nav cart button, render the sidebar items (with edit buttons) and open the sidebar.
document.addEventListener('DOMContentLoaded', function(){
    try{
        var cartImg = document.querySelector('img[alt="Cart"]');
        if(!cartImg) return;
        var btn = cartImg.closest('button');
        if(!btn) return;
        btn.addEventListener('click', function(e){
            try{ e.preventDefault(); }catch(ex){}
            // render items and totals
            renderCartSidebarItems(); renderCartSidebarUI();
            // open sidebar overlay if present
            var overlay = document.getElementById('cartOverlay');
            var sidebar = document.getElementById('cartSidebar');
            if(overlay && sidebar){ overlay.classList.add('show'); sidebar.classList.add('open'); document.body.style.overflow = 'hidden'; sidebar.setAttribute('aria-hidden','false'); overlay.setAttribute('aria-hidden','false'); }
        });
    }catch(e){ /* ignore */ }
});

// Observe cart sidebar open/close so we can render items immediately when it opens
document.addEventListener('DOMContentLoaded', function(){
    try{
        var sidebar = document.getElementById('cartSidebar');
        if(!sidebar) return;
        var obs = new MutationObserver(function(mutations){
            mutations.forEach(function(m){
                if(m.attributeName === 'class'){
                    try{
                        if(sidebar.classList.contains('open')){
                            renderCartSidebarItems(); renderCartSidebarUI();
                        }
                    }catch(e){}
                }
            });
        });
        obs.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    }catch(e){}
});

// --- Session integrity helpers -------------------------------------------------
// Ensure pages restored from bfcache or visited via back/forward validate the active session
function getActiveProfile(){ try{ return JSON.parse(localStorage.getItem('profile') || 'null'); }catch(e){ return null; } }

// Public helper pages can call to ensure an interactive action has an authenticated Firebase user.
// If Firebase is available we prefer it; otherwise fall back to legacy localStorage profile check.
window.ensureSignedInOrRedirect = function(returnUrl){
    try{
        if(window.firebase && firebase.auth){
            var u = firebase.auth().currentUser;
            if(!u){
                var redirect = 'login.html'; if(returnUrl) redirect += '?return=' + encodeURIComponent(returnUrl);
                try{ alert('Please sign in to continue. Redirecting to login.'); }catch(e){}
                window.location.href = redirect;
                return false;
            }
            return true;
        }
        // No firebase available — fall back to localStorage profile
        try{ var p = JSON.parse(localStorage.getItem('profile')||'null'); if(!p || !p.email){ var redirect='login.html'; if(returnUrl) redirect += '?return=' + encodeURIComponent(returnUrl); window.location.href = redirect; return false; } }catch(e){ window.location.href = 'login.html'; return false; }
        return true;
    }catch(e){ return false; }
};

// Remove all locally-stored data associated with a given email (orders, profile, cart, wishlist)
function clearAccountLocalDataByEmail(email){
    if(!email) return;
    try{
        // Clear current profile if it matches
        try{ var prof = JSON.parse(localStorage.getItem('profile')||'null'); if(prof && (prof.email||'').toLowerCase() === (email||'').toLowerCase()){ localStorage.removeItem('profile'); localStorage.removeItem('profile_updated_at'); } }catch(e){}
        // Remove orders that reference this email
        try{
            var orders = JSON.parse(localStorage.getItem('orders')||'[]') || [];
            var filtered = orders.filter(function(o){ var candidates = [o.email, o.customerEmail, (o.profile && o.profile.email), (o.customer && o.customer.email)]; return !candidates.some(function(c){ return (c||'').toLowerCase() === (email||'').toLowerCase(); }); });
            localStorage.setItem('orders', JSON.stringify(filtered));
        }catch(e){}
        // Remove cart if it appears to belong to the deleted user (best-effort: compare profile email to cart owner if stored)
        try{
            var cart = JSON.parse(localStorage.getItem('cart')||'[]');
            // Heuristic: if there is a saved profile with this email, we already removed it above; remove cart entirely
            localStorage.removeItem('cart');
        }catch(e){}
        // Remove wishlist (best-effort local cleanup)
        try{ localStorage.removeItem('wishlist'); }catch(e){}
        // Add the email to a pending deletion queue so any server-side cleanup tooling can pick it up
        try{
            var pending = JSON.parse(localStorage.getItem('pendingFirebaseUserDeletions')||'[]') || [];
            if(!pending.some(function(x){ return (x||'').toLowerCase() === (email||'').toLowerCase(); })){
                pending.push(email);
                localStorage.setItem('pendingFirebaseUserDeletions', JSON.stringify(pending));
            }
        }catch(e){}
    }catch(e){ console.warn('clearAccountLocalDataByEmail failed', e); }
}

// Listen for Firebase auth state changes and clear local profile/data when the user becomes null
// Install an auth-state listener when Firebase becomes available. We poll briefly in case
// cart-storage.js is loaded before the Firebase libs/scripts on the page.
function _attachFirebaseAuthListener(){
    try{
        var __lastKnownProfile = null; try{ __lastKnownProfile = JSON.parse(localStorage.getItem('profile')||'null'); }catch(e){ __lastKnownProfile = null; }
        firebase.auth().onAuthStateChanged(function(user){
            try{
                if(!user){
                    try{ var stored = JSON.parse(localStorage.getItem('profile')||'null'); if(stored && stored.email){ clearAccountLocalDataByEmail(stored.email); } }catch(e){}
                } else {
                    try{
                        var p = JSON.parse(localStorage.getItem('profile')||'null') || {};
                        p.email = p.email || user.email || '';
                        p.uid = user.uid || p.uid || null;
                        localStorage.setItem('profile', JSON.stringify(p));
                    }catch(e){}
                }
            }catch(e){ /* ignore */ }
        });
    }catch(e){ /* ignore */ }
}

if(window.firebase && firebase.auth){
    _attachFirebaseAuthListener();
} else {
    // Poll for Firebase availability for a short period (3 seconds)
    var __fbPollCount = 0;
    var __fbPollInterval = setInterval(function(){
        __fbPollCount++;
        if(window.firebase && firebase.auth){
            clearInterval(__fbPollInterval);
            _attachFirebaseAuthListener();
            return;
        }
        if(__fbPollCount > 30){ // stop after ~3s
            clearInterval(__fbPollInterval);
            return;
        }
    }, 100);
}

// Sign out helper that clears session-scoped profile and replaces the current history entry
window.signOut = function(){
    try{ localStorage.removeItem('profile'); localStorage.removeItem('profile_updated_at'); }catch(e){}
    try{ localStorage.removeItem('authToken'); localStorage.removeItem('authTokenUpdatedAt'); }catch(e){}
    // Replace current location so back won't return to a page that assumes the previous profile
    try{ window.location.replace('login.html'); }catch(e){ window.location.href = 'login.html'; }
};

// When a page is restored from bfcache (pageshow with persisted=true) or navigated via back/forward,
// ensure it reflects the current session. If the DOM shows a different user's email than the active
// session, redirect to login so the user can't view another account via the back button.
window.addEventListener('pageshow', function(ev){
    try{
        var p = getActiveProfile();
        // look for a few common account-email holders used across pages
        var accountEl = document.getElementById('accountEmail') || document.querySelector('.checkout-account') || document.querySelector('[data-account-email]');
        if(accountEl){
            var shown = (accountEl.textContent || '').trim();
            // try to extract an email from the shown text
            var m = shown.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
            var shownEmail = m ? m[0] : null;
            if(!p || !p.email){
                // No active session but page shows account info -> force login
                window.location.replace('login.html');
                return;
            }
            if(shownEmail && p.email && shownEmail.toLowerCase() !== String(p.email).toLowerCase()){
                // Mismatch between DOM and active session — don't allow viewing; force login
                window.location.replace('login.html');
                return;
            }
        } else {
            // Generic check: if page contains elements that should be protected (data-protected="true"), enforce session
            var protectedEl = document.querySelector('[data-protected="true"]');
            if(protectedEl && (!p || !p.email)){
                window.location.replace('login.html');
                return;
            }
        }
    }catch(e){ /* ignore */ }
});

function removeFromCart(idx) {
    let cart = getCart();
    cart.splice(idx, 1);
    saveCart(cart);
}

function clearCart() {
    saveCart([]);
}

// Render cart items inside the sidebar/modal in a consistent way and attach edit handlers.
function renderCartSidebarItems(){
    try{
        var cart = getCart();
        var container = document.getElementById('cartItems');
        if(!container) return;
        container.innerHTML = '';
        if(!Array.isArray(cart) || cart.length === 0){
            var empty = document.createElement('div'); empty.className = 'cart-empty'; empty.textContent = 'Your cart is empty'; container.appendChild(empty); return;
        }
        cart.forEach(function(item, index){
            var box = document.createElement('div'); box.className = 'cart-item-box';
            var img = document.createElement('img'); img.className = 'cart-item-img'; img.src = item.image || 'IMAGE/NIKE1.png'; img.alt = item.title || 'Product';
            var middle = document.createElement('div'); middle.className = 'cart-item-middle';
            var title = document.createElement('div'); title.className = 'cart-item-title'; title.textContent = item.title || '';
            var brand = document.createElement('div'); brand.className = 'cart-item-brand'; brand.textContent = item.brand || '';
            var size = document.createElement('div'); size.className = 'cart-item-size'; size.textContent = 'Size: ' + (item.size || '');
            var qtyControls = document.createElement('div'); qtyControls.className = 'cart-quantity-controls';
            var lessenBtn = document.createElement('button'); lessenBtn.className = 'qty-btn decrease'; lessenBtn.setAttribute('data-index', index);
            var lessenImg = document.createElement('img'); lessenImg.src = 'IMAGE/LessenBTN.png'; lessenImg.alt = '-'; lessenImg.style.width='22px'; lessenImg.style.height='22px'; lessenBtn.appendChild(lessenImg);
            var qtyText = document.createElement('span'); qtyText.className = 'cart-item-qty'; qtyText.textContent = item.quantity || (item.qty || 1);
            var addBtn = document.createElement('button'); addBtn.className = 'qty-btn increase'; addBtn.setAttribute('data-index', index);
            var addImg = document.createElement('img'); addImg.src = 'IMAGE/AddBTN.png'; addImg.alt='+'; addImg.style.width='22px'; addImg.style.height='22px'; addBtn.appendChild(addImg);
            qtyControls.appendChild(lessenBtn); qtyControls.appendChild(qtyText); qtyControls.appendChild(addBtn);
            middle.appendChild(title); middle.appendChild(brand); middle.appendChild(size); middle.appendChild(qtyControls);
            var actions = document.createElement('div'); actions.style.display='flex'; actions.style.flexDirection='column'; actions.style.gap='6px';
            var editBtn = document.createElement('button'); editBtn.className = 'btn ghost cart-item-edit'; editBtn.textContent = 'Edit'; editBtn.setAttribute('data-index', index);
            var removeBtn = document.createElement('button'); removeBtn.className = 'cart-item-remove'; removeBtn.setAttribute('data-index', index);
            var trashImg = document.createElement('img'); trashImg.src='IMAGE/TrashIcon.png'; trashImg.alt='Remove'; trashImg.style.width='18px'; trashImg.style.height='18px'; removeBtn.appendChild(trashImg);
            actions.appendChild(editBtn); actions.appendChild(removeBtn);
            var priceEl = document.createElement('div'); priceEl.className = 'cart-item-price'; priceEl.textContent = (function(){ try{ return new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format((item.price||0) * (item.quantity || item.qty || 1)); }catch(e){ return '₱'+(((item.price||0)*(item.quantity||item.qty||1)).toFixed(2)); } })();
            box.appendChild(img); box.appendChild(middle); box.appendChild(actions); box.appendChild(priceEl);
            container.appendChild(box);
        });
        // attach basic handlers (increase/decrease/remove/edit)
        container.querySelectorAll('.qty-btn.decrease').forEach(function(btn){ btn.onclick = function(){ var idx = Number(btn.getAttribute('data-index')); var cart = getCart(); if(!cart[idx]) return; if((cart[idx].quantity||cart[idx].qty||1) > 1){ cart[idx].quantity = (cart[idx].quantity||cart[idx].qty||1) - 1; saveCart(cart); renderCartSidebarItems(); renderCartSidebarUI(); } }; });
        container.querySelectorAll('.qty-btn.increase').forEach(function(btn){ btn.onclick = function(){ var idx = Number(btn.getAttribute('data-index')); var cart = getCart(); if(!cart[idx]) return; cart[idx].quantity = (cart[idx].quantity||cart[idx].qty||1) + 1; // respect inventory cap
                var max = getMaxAllowedForProduct(cart[idx]); if(cart[idx].quantity > max) cart[idx].quantity = max; saveCart(cart); renderCartSidebarItems(); renderCartSidebarUI(); }; });
        container.querySelectorAll('.cart-item-remove').forEach(function(btn){ btn.onclick = function(){ var idx = Number(btn.getAttribute('data-index')); var cart = getCart(); if(isNaN(idx)) return; cart.splice(idx,1); saveCart(cart); renderCartSidebarItems(); renderCartSidebarUI(); }; });
        container.querySelectorAll('.cart-item-edit').forEach(function(btn){ btn.onclick = function(){ var idx = Number(btn.getAttribute('data-index')); openCartItemEditor(idx); }; });
    }catch(e){ console.error('renderCartSidebarItems error', e); }
}

// Open modal to edit a cart item's selectable attributes (color, size). Changes apply only to cart.
function openCartItemEditor(index){
    var cart = getCart(); if(!cart || !Array.isArray(cart) || !cart[index]) return;
        var item = cart[index];
        // build modal overlay
    var existing = document.getElementById('cartEditModalOverlay'); if(existing) existing.remove();
    // reuse existing bank-modal styles so the modal appears above the cart sidebar and uses Poppins + btn styles
    var overlay = document.createElement('div'); overlay.id = 'cartEditModalOverlay'; overlay.className = 'bank-modal-overlay show';
    // Ensure overlay behaves as a centered, full-screen layer even if page lacks bank-modal CSS
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    // Force a semi-opaque backdrop so modal content is readable
    overlay.style.background = 'rgba(0,0,0,0.5)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '20px';
    overlay.style.boxSizing = 'border-box';
    // Ensure overlay is above other page layers (cart sidebar had z-index ~99999)
    overlay.style.zIndex = '1002000';
    var modal = document.createElement('div'); modal.className = 'bank-modal cart-edit-modal';
    // Ensure modal is constrained and scrolls if content exceeds viewport
    // Make modal wider on larger screens to avoid internal horizontal scrolling,
    // but remain responsive on small viewports.
    modal.style.width = 'min(760px, calc(100vw - 40px))';
    modal.style.maxWidth = '760px';
    modal.style.maxHeight = 'calc(100vh - 80px)';
    modal.style.overflowY = 'auto';
    modal.style.boxSizing = 'border-box';
    modal.style.position = 'relative';
    modal.style.zIndex = '1002001';
    // Ensure visible white background and comfortable padding so content never appears transparent
    modal.style.background = '#ffffff';
    modal.style.padding = '20px';
    modal.style.borderRadius = '12px';
    modal.style.boxShadow = '0 12px 48px rgba(0,0,0,0.28)';
    modal.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h3 style="margin:0;font-size:1.05rem;">Edit item</h3><button id="cartEditCloseBtn" class="bank-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;">✕</button></div>`;
        var content = document.createElement('div');
        // Left: image
    var left = document.createElement('div'); left.style.float='none'; left.style.marginRight='0'; left.style.width='140px'; left.innerHTML = `<img src="${item.image||'IMAGE/NIKE1.png'}" alt="${item.title||''}" style="width:140px;height:140px;object-fit:contain;border:1px solid #eee;border-radius:8px;background:#fff;"/>`;
        content.appendChild(left);
        // Right: details
            var right = document.createElement('div');
            // Use flex layout inside the modal to avoid floats and horizontal scrollbars
            right.style.flex = '1';
            right.style.minWidth = '0';
        var title = document.createElement('div'); title.style.fontWeight='600'; title.style.marginBottom='6px'; title.textContent = item.title || '';
        var brand = document.createElement('div'); brand.style.color='#666'; brand.style.marginBottom='10px'; brand.textContent = item.brand || '';
        right.appendChild(title); right.appendChild(brand);
        // Determine available colors. Prefer grouped model data (`modelData.variants`) when it
        // clearly corresponds to this cart item so the editor mirrors the product page. Otherwise
        // fall back to the inventory-based scan that collects sibling rows and embedded variants.
        var colors = [];
        var usedModelData = false;
        try{
                // Try modelData first (grouped model from product page). Match by title/baseName token overlap
                try{
                    var modelDataProbe = null;
                    try{ modelDataProbe = JSON.parse(localStorage.getItem('modelData') || 'null'); }catch(e){ modelDataProbe = null; }
                    if(modelDataProbe && Array.isArray(modelDataProbe.variants) && modelDataProbe.variants.length){
                        var mdName = (modelDataProbe.title || modelDataProbe.name || modelDataProbe.productTitle || modelDataProbe.baseName || '').toString().trim().toLowerCase();
                        var itemName = (item.title || item.name || '').toString().trim().toLowerCase();
                        // Prefer explicit identity matches between the cart item and modelDataProbe.
                        // Only fall back to an exact-name match; do NOT rely on fuzzy token overlap.
                        try{
                            var matchFound = false;
                            // Only accept modelData when there is an explicit variant id match.
                            // Avoid image/name heuristics — they are too permissive and can leak the
                            // last-viewed product's variants into unrelated cart items.
                            try{
                                if(item.inventoryId || item.id){
                                    matchFound = modelDataProbe.variants.some(function(v){ try{
                                        if(!v) return false;
                                        if(item.inventoryId && v.id && String(v.id) === String(item.inventoryId)) return true;
                                        if(item.id && v.id && String(v.id) === String(item.id)) return true;
                                        return false;
                                    }catch(e){ return false; } });
                                }
                            }catch(e){}
                            if(matchFound){
                                usedModelData = true;
                                try{ modal._colorsSource = 'modelData'; }catch(e){}
                                // push modelData variants as color entries; include top-level model gender hints
                                modelDataProbe.variants.forEach(function(v){ if(!v) return; try{ colors.push({ record: v, parent: null, color: v.color || v.name || '', image: v.image || '', sizes: v.sizes || v.sizeMap || {} }); }catch(e){} });
                                // DO NOT push top-level model gender into the colors array (it creates an
                                // extra color option). Gender should be handled separately below.
                            }
                        }catch(e){}
                    }
                }catch(e){ /* ignore */ }
                if(!usedModelData){
                var invItem = null;
                try{
                    // Prefer direct inventoryId on the cart item (added at add-time) for exact lookup.
                    var invAllProbe = getInventoryRowsCache();
                    if(item && item.inventoryId){
                        try{ invItem = invAllProbe.find(function(x){ return x && x.id && String(x.id) === String(item.inventoryId); }); }catch(e){}
                    }
                    // If inventoryId is not present, be conservative: only attempt an exact-name or exact-id lookup.
                    // Avoid invoking fuzzy/global lookups here because they can pick up unrelated rows (the
                    // "most recently viewed product" problem) and cause the edit modal to change when new
                    // items are added to the cart. We intentionally avoid `findInventoryItemForProduct`
                    // which contains permissive heuristics.
                    if(!invItem){
                        try{
                            var titleNorm = (item && item.title) ? String(item.title).trim().toLowerCase() : '';
                            if(titleNorm){
                                invItem = invAllProbe.find(function(x){ try{ return x && x.name && String(x.name).trim().toLowerCase() === titleNorm; }catch(e){ return false; } });
                            }
                        }catch(e){}
                        if(!invItem && item && item.id){ try{ invItem = invAllProbe.find(function(x){ return x && x.id && String(x.id) === String(item.id); }); }catch(e){} }
                    }
                }catch(e){ invItem = null; }
            if(invItem){
                try{ modal._colorsSource = 'inventory'; }catch(e){}
                // Gather all inventory rows that represent the same product model so the editor
                // shows every color/row that exists in the inventory for this model. This covers
                // two common patterns: (A) variants array inside a single inventory row, and
                // (B) multiple inventory rows (one per color) that share the same name/model.
                var invAll = getInventoryRowsCache();
                var matchedRows = [];
                try{
                    var norm = function(s){ return (String(s||'').trim().toLowerCase()); };
                    var targetName = norm(invItem.name || invItem.title || invItem.model || '');
                    // First, include the canonical invItem itself
                    matchedRows.push(invItem);
                    // Then scan for sibling rows that clearly represent the same model. Be strict here:
                    // only include rows that match by exact name, explicit id equality, explicit parent/child
                    // linkage, or embedded variant children. Avoid token-based fuzzy intersection which can
                    // mistakenly treat unrelated rows as siblings (this is the root cause of modal leakage).
                    invAll.forEach(function(r){ if(!r) return; try{
                        if(r === invItem) return;
                        var sameId = (invItem.id && r.id && String(invItem.id) === String(r.id));
                        var rn = norm(r.name || r.title || '');
                        var sameName = (targetName && rn && rn === targetName);
                        var parentLink = (r.parentId && invItem.id && String(r.parentId) === String(invItem.id)) || (r.parent && invItem.id && String(r.parent) === String(invItem.id));
                        var childOfTarget = (invItem.variants && Array.isArray(invItem.variants) && invItem.variants.some(function(v){ try{ return v && (v.id && r.id && String(v.id) === String(r.id)); }catch(e){ return false; } }));
                        if(sameId || sameName || parentLink || childOfTarget){ matchedRows.push(r); }
                    }catch(e){} });
                    // If invItem has variants embedded, include them as well (they may contain separate sizes/images)
                    if(Array.isArray(invItem.variants) && invItem.variants.length>0){ invItem.variants.forEach(function(v){ if(v) matchedRows.push(v); }); }
                }catch(e){ /* ignore */ }
                // Deduplicate matchedRows by id or by normalized name+color+image filename
                var seen = new Set();
                var unique = [];
                matchedRows.forEach(function(r){ try{
                    var namePart = (r && (r.name || r.title || r.model) || '').toString().trim().toLowerCase();
                    var colorPart = (r && (r.color || r.colorName) || '').toString().trim().toLowerCase();
                    var imgPart = '';
                    try{ imgPart = (r && (r.image || (r.images && r.images[0]) ) || '').toString().split('/').pop().split('?')[0].toLowerCase(); }catch(_){ imgPart = ''; }
                    // Use a dedupe key that includes colorId when present. Some inventories unfortunately
                    // contain multiple rows with the same id but different color variants (different colorId).
                    // Collapsing solely on id hides distinct color options; prefer id::colorId when available.
                    var key = '';
                    if(r && r.id){
                        if(r.colorId) key = String(r.id) + '::' + String(r.colorId);
                        else key = String(r.id);
                    } else {
                        key = namePart + '::' + colorPart + '::' + imgPart;
                    }
                    if(!seen.has(key)){ seen.add(key); unique.push(r); }
                }catch(e){ }
                });
                // Map unique rows/variants into color entries, avoiding duplicate color labels
                var seenColorLabels = new Set();
                unique.forEach(function(r){ if(!r) return; try{
                    var parent = (r === invItem) ? null : (r.parentId || r.parent) ? invItem : null;
                    var colorLabel = (r.color || r.colorName || r.name || '').toString().trim();
                    var imageUrl = (r.image || (r.images && r.images[0]) || invItem.image || item.image || '');
                    var sizesMap = r.sizes || r.sizeMap || (r.sizes || {});
                    // normalize color label for deduping (lowercase, trimmed)
                    var colorNorm = colorLabel.toLowerCase();
                    if(colorNorm && seenColorLabels.has(colorNorm)){
                        // skip duplicate color label entries
                        return;
                    }
                    if(colorNorm) seenColorLabels.add(colorNorm);
                    colors.push({ record: r, parent: parent ? invItem : null, color: colorLabel, image: imageUrl, sizes: sizesMap });
                }catch(e){} });
            } else {
                try{ modal._colorsSource = 'fallback'; }catch(e){}
                // Fallback: scan inventory but be conservative: prefer exact name or id matches only
                var inv = getInventoryRowsCache();
                inv.forEach(function(r){
                    if(!r) return;
                    var added = false;
                    try{ if(item.id && r.id && String(item.id) === String(r.id)){ colors.push({ record: r, color: r.color || r.colorName || r.name || '', image: r.image || (r.images && r.images[0]) || '', sizes: r.sizes || {} }); added = true; } }catch(e){}
                    try{ if(!added && r.name && (r.name||'').toString().trim().toLowerCase() === (item.title||'').toString().trim().toLowerCase()){ colors.push({ record: r, color: r.color || r.colorName || r.name || '', image: r.image || (r.images && r.images[0]) || '', sizes: r.sizes || {} }); added = true; } }catch(e){}
                });
                // Ensure at least current color present as a last resort
                if(colors.length === 0){ colors.push({ color: item.color || item.colorName || '', image: item.image || '', sizes: {} }); }
                    }
                }
        }catch(e){
            // best-effort fallback
            try{ colors.push({ color: item.color || item.colorName || '', image: item.image || '', sizes: {} }); }catch(_){ }
        }
    var colorRow = document.createElement('div'); colorRow.style.marginBottom='10px'; colorRow.innerHTML = '<div style="font-size:0.95rem;margin-bottom:6px;">Colors</div>';
    var colorButtons = document.createElement('div'); colorButtons.style.display='flex'; colorButtons.style.gap='8px';
    // Prepare Gender-Fit area early so color button handlers can safely call the renderer
    var genderRow = document.createElement('div'); genderRow.style.marginBottom = '8px';
    genderRow.innerHTML = '<div style="font-size:0.95rem;margin-bottom:6px;">Gender-Fit</div>';
    var genderWrap = document.createElement('div'); genderWrap.style.display = 'flex'; genderWrap.style.gap = '8px'; genderRow.appendChild(genderWrap);
    // Append genderRow later after colorRow so layout remains consistent; handlers may rely on genderWrap existing
        // Ensure the cart item's existing color remains present so editing won't lose it
        try{
            var itemColorNorm_check = (item.color || item.colorName || '').toString().trim().toLowerCase();
            if(itemColorNorm_check){
                var foundExistingColor = colors.some(function(cc){ try{ var cn = (cc.color||'').toString().trim().toLowerCase(); return cn === itemColorNorm_check; }catch(e){ return false; } });
                if(!foundExistingColor){
                    // Prepend a fallback color entry representing the currently-selected value on the cart item
                    colors.unshift({ record: null, parent: null, color: item.color || item.colorName || '', image: item.image || '', sizes: {} });
                }
            }
        }catch(e){}

        // Build color buttons and try several match strategies so the cart item's
        // previously-selected color maps reliably to the inventory color entry.
        // Use local selection state (do not persist selection on the modal element) so
        // different edit modals don't leak selection state into each other.
        var selectedColorIdx = undefined;
        var selectedSizeVal = undefined;
        var selectedGenderVal = undefined;

        colors.forEach(function(c, ci){
            var b = document.createElement('button');
            b.className = 'btn ghost cart-edit-color';
            b.textContent = c.color || ('Color ' + (ci+1));
            b.setAttribute('data-index', ci);
                // matching strategies (in order): exact inventory id, image url filename match,
                // normalized color name
            try{
                var matched = false;
                // 1) match by inventoryId or item.id if present (check record and parent)
                if(!matched && (item.inventoryId || item.id)){
                    try{ if(c.record && c.record.id && (item.inventoryId ? String(item.inventoryId) === String(c.record.id) : String(item.id) === String(c.record.id))) matched = true; }catch(_){}
                    try{ if(!matched && c.parent && c.parent.id && (item.inventoryId ? String(item.inventoryId) === String(c.parent.id) : String(item.id) === String(c.parent.id))) matched = true; }catch(_){}
                }
                // 2) match by image url (compare filenames) - prefer visual match when available
                if(!matched && item.image && c.image){
                    try{
                        var a = (item.image||'').split('/').pop().split('?')[0].toLowerCase();
                        var bfn = (c.image||'').split('/').pop().split('?')[0].toLowerCase();
                        if(a && bfn && a === bfn) matched = true;
                    }catch(_){ }
                }
                // 3) match by normalized color string
                var itemColorNorm = (item.color || item.colorName || '').toString().trim().toLowerCase();
                var cColorNorm = (c.color || (c.record && (c.record.color||c.record.colorName)) || '').toString().trim().toLowerCase();
                if(!matched && itemColorNorm && cColorNorm && itemColorNorm === cColorNorm) matched = true;
                // Prefer to auto-select the button that matches the existing cart item's color
                if(matched && typeof selectedColorIdx === 'undefined'){ b.classList.remove('ghost'); b.classList.add('primary'); selectedColorIdx = ci; }
            }catch(e){}

            b.onclick = function(){ // mark selected
                colorButtons.querySelectorAll('button').forEach(function(x){ x.classList.remove('primary'); x.classList.add('ghost'); });
                b.classList.remove('ghost'); b.classList.add('primary');
                // update preview image
                var imgEl = left.querySelector('img'); if(c.image) imgEl.src = c.image; else imgEl.src = item.image || imgEl.src;
                // store selected index locally
                selectedColorIdx = ci;
                // update sizes shown for this color
                renderSizesForColor(ci);
                // update gender buttons for this color as well
                try{ renderGenderButtonsForColor(ci); }catch(e){}
            };

            colorButtons.appendChild(b);
        });
        // Ensure exactly one color button is marked selected. Prefer the matched index; otherwise default to 0.
        try{
            var allColorBtns = colorButtons.querySelectorAll('button');
            // If we didn't find a matching color above, prefer to select the button whose
            // label matches the item's color; otherwise default to the first button.
            if(typeof selectedColorIdx === 'undefined' && allColorBtns.length > 0){
                var itemColorNorm2 = (item.color || item.colorName || '').toString().trim().toLowerCase();
                if(itemColorNorm2){
                    for(var xi=0; xi<allColorBtns.length; xi++){
                        try{
                            var btn = allColorBtns[xi]; var ci = Number(btn.getAttribute('data-index')); var c = colors[ci];
                            var cLabel = (c && c.color) ? String(c.color).trim().toLowerCase() : '';
                            if(cLabel === itemColorNorm2){ selectedColorIdx = ci; break; }
                        }catch(e){}
                    }
                }
                if(typeof selectedColorIdx === 'undefined') selectedColorIdx = 0;
            }
            allColorBtns.forEach(function(btn){ try{
                var idx = Number(btn.getAttribute('data-index'));
                if(idx === selectedColorIdx){ btn.classList.remove('ghost'); btn.classList.add('primary'); }
                else { btn.classList.remove('primary'); btn.classList.add('ghost'); }
            }catch(e){}
            });
            // ensure the preview image reflects the selected color immediately
            try{
                var imgEl = left.querySelector('img');
                if(imgEl){
                    var imgForSel = (colors[selectedColorIdx] && colors[selectedColorIdx].image) ? colors[selectedColorIdx].image : (item.image || imgEl.src || '');
                    if(imgForSel) imgEl.src = imgForSel;
                }
            }catch(e){}
            // ensure genders reflect the selected color as well
            try{ renderGenderButtonsForColor(selectedColorIdx !== undefined ? selectedColorIdx : 0); }catch(e){}
        }catch(e){}
    right.appendChild(colorRow); colorRow.appendChild(colorButtons);
    // Gender-Fit area (already prepared above) — append the pre-created node
    right.appendChild(genderRow);
        // Sizes: use sizes from selected color inventory entry if available, else fallback to first
        var sizesObj = (colors[0] && colors[0].sizes) ? colors[0].sizes : {};
        var sizeRow = document.createElement('div'); sizeRow.style.marginBottom='10px'; sizeRow.innerHTML = '<div style="font-size:0.95rem;margin-bottom:6px;">Sizes</div>';
    var sizeButtons = document.createElement('div'); sizeButtons.style.display='flex'; sizeButtons.style.flexWrap='wrap'; sizeButtons.style.gap='6px';
    // element that shows numeric stock and low-stock warning
    var sizeStockDiv = document.createElement('div'); sizeStockDiv.style.fontSize = '0.95rem'; sizeStockDiv.style.marginTop = '6px'; sizeStockDiv.style.color = '#222';
        // collect size keys
        // helper to (re)render sizes for a selected color index
        function renderSizesForColor(colorIndex){
            try{
                sizeButtons.innerHTML = '';
                var sObj = (colors[colorIndex] && colors[colorIndex].sizes) ? colors[colorIndex].sizes : {};
                var keys = Object.keys(sObj || {}).sort(function(a,b){ return Number(a) - Number(b); });
                if(keys.length === 0){ keys = [ item.size || '' ]; }
                keys.forEach(function(s){ var available = (sObj && sObj[s] !== undefined) ? Number(sObj[s]) : 0;
                    var sb = document.createElement('button'); sb.className='btn ghost product-size-btn cart-edit-size'; sb.textContent = s; sb.setAttribute('data-size', s); sb.setAttribute('data-available', String(available));
                    // clear previous state classes
                    sb.classList.remove('low-stock','oos');
                    if(available <= 0){ sb.disabled = true; sb.classList.add('oos'); }
                    else { sb.disabled = false; if(available < 6) sb.classList.add('low-stock'); }
                        if((item.size||'') == s){ sb.classList.remove('ghost'); sb.classList.add('primary'); selectedSizeVal = s; }
                        sb.onclick = function(){ if(sb.disabled) return; sizeButtons.querySelectorAll('button').forEach(function(x){ x.classList.remove('primary'); x.classList.add('ghost'); }); sb.classList.remove('ghost'); sb.classList.add('primary'); selectedSizeVal = s; updateSizeStockDisplay(s); };
                    sizeButtons.appendChild(sb);
                });
                // update stock display for a selected size
                function updateSizeStockDisplay(selectedSize){
                    try{
                        var avail = (sObj && sObj[selectedSize] !== undefined) ? Number(sObj[selectedSize]) : 0;
                        sizeStockDiv.textContent = 'Stock: ' + (isNaN(avail)?0:avail) + ' available';
                        if(!isNaN(avail) && avail > 0 && avail < 6){ var warn = document.createElement('span'); warn.style.color = '#c62828'; warn.style.fontWeight = '700'; warn.style.marginLeft = '8px'; warn.textContent = 'LOW STOCK!'; sizeStockDiv.appendChild(warn); }
                    }catch(e){}
                }
                // ensure display reflects initial selection
                try{ if(selectedSizeVal) updateSizeStockDisplay(selectedSizeVal); else if(keys.length>0) { var sel = (item.size||keys[0]); updateSizeStockDisplay(sel); } }catch(e){}
            }catch(e){ console.error('renderSizesForColor error', e); }
        }

        // render sizes for the initially selected color (or default 0)
        renderSizesForColor(selectedColorIdx !== undefined ? selectedColorIdx : 0);
        right.appendChild(sizeRow); sizeRow.appendChild(sizeButtons); sizeRow.appendChild(sizeStockDiv);
        // Render gender buttons from the inventory record for the selected color
        function renderGenderButtonsForColor(colorIndex){
            try{
                genderWrap.innerHTML = '';
                // Aggregate gender/genderFit across all color entries so the editor exposes every
                // gender option that exists for this product model (per requirement).
                var gset = new Set();
                try{
                    // helper: split token lists like "Men/Women" or "Men, Women" into individual entries
                    function addGenderTokens(raw){ try{ if(!raw) return; String(raw).split(/[\/\\,|;]+/).map(function(x){ return (x||'').toString().trim(); }).filter(function(t){ return t; }).forEach(function(t){ gset.add(t); }); }catch(e){} }
                    colors.forEach(function(c){ if(!c) return; try{
                        var r = c.record || null;
                        if(r){ addGenderTokens(r.gender); addGenderTokens(r.genderFit); }
                        // include parent if present
                        if(c.parent){ var p = c.parent; addGenderTokens(p.gender); addGenderTokens(p.genderFit); }
                        // if variant-like object contains nested variants, include them as well
                        if(r && Array.isArray(r.variants)){
                            r.variants.forEach(function(v){ try{ if(v){ addGenderTokens(v.gender); addGenderTokens(v.genderFit); } }catch(_){} });
                        }
                    }catch(e){} });
                }catch(e){}
                var present = Array.from(gset).map(function(p){ return String(p||'').trim(); }).filter(function(x){ return x; });
                // helper to normalise various gender labels to our canonical display values
                function canonicalizeGender(p){ try{ if(!p) return ''; var s = String(p||'').trim(); if(/^m(en|'')?$/i.test(s) || /^men/i.test(s) || /\bmens?\b/i.test(s) || /\bman's?\b/i.test(s)) return 'Men'; if(/^w(omen|'')?$/i.test(s) || /^women/i.test(s) || /\bwomens?\b/i.test(s)) return 'Women'; if(/unisex/i.test(s) || /uni[- ]?sex/i.test(s)) return 'Unisex'; return s; }catch(e){ return String(p||''); } }
                var canonical = present.map(function(p){ return canonicalizeGender(p); });
                var order = ['Men','Women','Unisex'];
                var unique = order.filter(function(o){ return canonical.indexOf(o)!==-1; }).concat(canonical.filter(function(x){ return order.indexOf(x)===-1; }));
                unique.forEach(function(g){ var btn = document.createElement('button'); btn.type='button'; btn.className='btn ghost product-size-btn gender-btn'; btn.setAttribute('data-gender', g); btn.textContent = g; btn.onclick = function(){ genderWrap.querySelectorAll('[data-gender]').forEach(function(n){ n.classList.remove('primary'); n.classList.add('ghost'); }); btn.classList.remove('ghost'); btn.classList.add('primary'); selectedGenderVal = g; }; genderWrap.appendChild(btn); });
                // default selection: prefer the selected color's gender if available, else item.gender, else first available
                try{
                    var selectedRec = (colors[colorIndex] && (colors[colorIndex].record || colors[colorIndex].parent)) ? (colors[colorIndex].record || colors[colorIndex].parent) : null;
                    var initial = null;
                    if(selectedRec){ initial = selectedRec.gender || selectedRec.genderFit || null; }
                    if(!initial) initial = item.gender || item.genderFit || null;
                    var canonicalInitial = initial ? canonicalizeGender(initial) : null;
                    if(canonicalInitial){ var match = genderWrap.querySelector('[data-gender="'+canonicalInitial+'"]'); if(match){ match.classList.remove('ghost'); match.classList.add('primary'); selectedGenderVal = canonicalInitial; } }
                    if(!selectedGenderVal){ var any = genderWrap.querySelector('[data-gender]'); if(any){ any.classList.remove('ghost'); any.classList.add('primary'); selectedGenderVal = any.getAttribute('data-gender'); } }
                }catch(e){}
            }catch(e){ console.error('renderGenderButtonsForColor error', e); }
        }
        // initial gender render
        renderGenderButtonsForColor(selectedColorIdx !== undefined ? selectedColorIdx : 0);
        // Confirm / Cancel
        var actionsRow = document.createElement('div'); actionsRow.style.display='flex'; actionsRow.style.justifyContent='flex-end'; actionsRow.style.gap='8px'; actionsRow.style.marginTop='12px';
    var cancelBtn = document.createElement('button'); cancelBtn.className='btn ghost'; cancelBtn.textContent='Cancel';
    var saveBtn = document.createElement('button'); saveBtn.className='btn primary'; saveBtn.textContent='Save changes';
        actionsRow.appendChild(cancelBtn); actionsRow.appendChild(saveBtn);
        right.appendChild(actionsRow);
            // Build a single row using flex so the left image and right details fit without overflow
            var row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '12px';
        row.style.alignItems = 'flex-start';
        // Allow the row to wrap on narrow viewports so the modal doesn't force horizontal scrolling
        row.style.flexWrap = 'wrap';
            // Left image fixed width
        left.style.flex = '0 0 140px';
        left.style.width = '140px';
        left.style.boxSizing = 'border-box';
            // Ensure the image inside scales down if necessary
            var imgEl = left.querySelector('img'); if(imgEl){ imgEl.style.width = '140px'; imgEl.style.height = '140px'; }
        row.appendChild(left);
        row.appendChild(right);
            modal.appendChild(row);
    // ensure our modal overlay sits above the cart sidebar even if bank-modal styles are absent
    overlay.style.zIndex = overlay.style.zIndex || '1001000';
    if(modal){ modal.style.zIndex = '1001001'; }
    overlay.appendChild(modal); document.body.appendChild(overlay);
    // Wire up close/cancel
    document.getElementById('cartEditCloseBtn').onclick = function(){ overlay.remove(); };
        cancelBtn.onclick = function(){ overlay.remove(); };
        // Save handler: apply selected color/size to cart item (only color image and size)
        saveBtn.onclick = function(){
            try{
                var selColorIdx = (selectedColorIdx !== undefined) ? selectedColorIdx : 0;
                var selSize = selectedSizeVal || item.size || '';
                var chosen = colors[selColorIdx] || colors[0];
                // update cart
                var cart2 = getCart();
                if(!cart2[index]) { overlay.remove(); return; }
                cart2[index].size = selSize;
                if(chosen && chosen.image) cart2[index].image = chosen.image;
                if(chosen && chosen.color) cart2[index].color = chosen.color;
                // save selected gender-fit if available
                try{ if(selectedGenderVal) cart2[index].gender = selectedGenderVal; }catch(e){}
                // ensure quantity doesn't exceed max for new size
                var max = getMaxAllowedForProduct(cart2[index]);
                if(cart2[index].quantity && cart2[index].quantity > max) cart2[index].quantity = max;
                saveCart(cart2);
                renderCartSidebarItems(); renderCartSidebarUI();
                overlay.remove();
            }catch(e){ console.error('save cart edit', e); overlay.remove(); }
    };

}
// Expose globally for inline event handlers
window.getCart = getCart;
window.saveCart = saveCart;
window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.clearCart = clearCart;
window.getMaxAllowedForProduct = getMaxAllowedForProduct;
window.findInventoryItemForProduct = findInventoryItemForProduct;
window.renderCartSidebarItems = renderCartSidebarItems;
window.openCartItemEditor = openCartItemEditor;

// Prime inventory cache when possible
try{ refreshInventoryRowsCache(); }catch(e){}
