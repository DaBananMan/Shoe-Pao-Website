// ensure-server.js
// Lightweight placeholder loaded on pages to avoid 404 when included.
// Future: this can perform an automated health-check and show a UI banner if the
// local Node API isn't running. For now it's intentionally minimal to avoid
// side effects in production-like environments.
(function(){
  try{
    if(typeof console !== 'undefined' && console.debug) console.debug('ensure-server.js loaded');
    // Expose a marker
    window.__shoepao_ensure_server = true;
    // Initial top-level verify probe removed to avoid top-level await usage.
    // verify-session logic runs later in the periodic checker which properly
    // handles async token refresh and sign-out behavior.

    // If running on localhost, prefer talking to the local Node server directly
    // instead of attempting to proxy through Apache/PHP. This avoids 404s when
    // `server-proxy.php` isn't present. The Node server listens on port 3000 by
    // default in this project.
    try{
      if(typeof window !== 'undefined' && window.location && window.location.hostname){
        var hn = (window.location.hostname||'').toLowerCase();
        if((hn === 'localhost' || hn === '127.0.0.1' || hn === '::1') && !window.API_BASE){
          window.API_BASE = 'http://localhost:3000';
        }
      }
    }catch(e){}

    // Monkey-patch fetch so any calls to relative 'api/...' or '/api/...' are forwarded to API_BASE.
    // Additionally provide a small "outbox" for POST/PUT to /api/orders so failed writes
    // are queued to localStorage and retried automatically when the backend becomes available.
    if(typeof window.fetch === 'function'){
      var origFetch = window.fetch.bind(window);

      // Outbox helpers
      var OUTBOX_KEY = 'order_outbox';
      function readOutbox(){ try{ return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }catch(e){ return []; } }
      function writeOutbox(q){ try{ localStorage.setItem(OUTBOX_KEY, JSON.stringify(q || [])); }catch(e){} }
      function enqueueOutbox(entry){ try{ var q = readOutbox(); q.push(entry); writeOutbox(q); console.info('order-outbox: queued', entry && entry.requestId); }catch(e){ console.warn('order-outbox: enqueue failed', e); } }

      // Try to flush outbox: attempt each queued request sequentially
      async function flushOutboxOnce(){ try{
          var q = readOutbox(); if(!Array.isArray(q) || q.length === 0) return;
          var base = String(window.API_BASE || '/server-proxy.php').replace(/\/+$/,'');
          var remaining = [];
          for(var i=0;i<q.length;i++){
            var e = q[i];
            try{
              var url = (e.path && e.path.indexOf('/')===0) ? (base + e.path) : (base + '/' + (e.path||''));
              var opts = { method: e.method || 'POST', headers: e.headers || { 'Content-Type': 'application/json' } };
              if(e.body) opts.body = e.body;
              var res = await origFetch(url, opts);
              if(res && res.ok){ console.info('order-outbox: flushed', e.requestId); continue; }
              // If non-ok (4xx/5xx) keep it for retry unless it's clearly invalid (4xx)
              if(res && res.status >= 400 && res.status < 500){ console.warn('order-outbox: server rejected request', res.status, e.requestId); continue; }
              // otherwise keep for retry
              remaining.push(e);
            }catch(err){
              // network or other error -> keep for retry
              remaining.push(e);
            }
          }
          if(remaining.length !== q.length) writeOutbox(remaining);
        }catch(e){ console.warn('order-outbox: flush failed', e); } }

      // Periodically flush outbox and when page gains connectivity
      try{ setInterval(flushOutboxOnce, 10000); window.addEventListener && window.addEventListener('online', flushOutboxOnce); }catch(e){}

      // Try to ensure the Node API server is running (local dev convenience).
      // This calls a small PHP script which will start the Node process via a helper
      // if it's not already running. It's safe because the PHP helper restricts
      // execution to Windows and local requests by default.
      try{
        if(window.location && window.location.hostname === 'localhost'){
          fetch('/tools/ensure-node.php', { method: 'GET', credentials: 'same-origin' }).then(function(r){
            return r.json().catch(function(){ return null; });
          }).then(function(json){
            try{ if(json) console.debug('ensure-node:', json); }catch(e){}
          }).catch(function(err){ /* ignore */ });
        }
      }catch(e){}

      window.fetch = function(input, init){
        try{
          var url = input;
          var opts = init || {};
          // If input is a Request object, extract its URL and method/body
          var isRequest = (typeof Request !== 'undefined' && input instanceof Request);
          var origRequest = null;
          if(isRequest){ origRequest = input; url = input.url; }

          if(typeof url === 'string'){
            var trimmed = url.trim();
            var lower = trimmed.toLowerCase();
            // skip absolute URLs (http(s)://) and protocol-relative (//)
            if(!(lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0 || lower.indexOf('//') === 0)){
              // If the request targets an API path like '/api/...' or 'api/...', rewrite to API_BASE
              if(trimmed.indexOf('/api/') === 0 || trimmed.indexOf('api/') === 0){
                // Ensure no double slashes
                var base = String(window.API_BASE || '/server-proxy.php').replace(/\/+$/,'');
                var path = trimmed.replace(/^\/+/, '');
                var newUrl = base + '/' + path;

                // For writes to /api/orders (POST/PUT) provide outbox behaviour on failures
                var method = (opts && opts.method) ? String(opts.method).toUpperCase() : (isRequest && origRequest && origRequest.method ? String(origRequest.method).toUpperCase() : 'GET');
                var shouldQueue = (method === 'POST' || method === 'PUT') && (path.indexOf('api/orders') === 0 || path.indexOf('orders') !== -1);

                if(isRequest){
                  var newReq = new Request(newUrl, input);
                  // attempt original fetch; on network error enqueue and reject so callers hit .catch
                  return origFetch(newReq, opts).catch(function(err){
                    try{
                      // read body from original request if possible (not always available)
                      var cloned = null; // not attempting to read stream here
                      if(shouldQueue){ enqueueOutbox({ requestId: 'rq_' + Date.now() + '_' + Math.floor(Math.random()*10000), path: '/' + path, method: method, headers: (opts && opts.headers) || {}, body: opts && opts.body ? opts.body : null }); }
                    }catch(e){ console.warn('order-outbox: enqueue error', e); }
                    return Promise.reject(err);
                  });
                }

                // non-Request string URL
                if(shouldQueue){
                  // Try fetch; if it fails (network), enqueue and reject promise so caller handles it
                  return origFetch(newUrl, opts).catch(function(err){
                    try{ enqueueOutbox({ requestId: 'rq_' + Date.now() + '_' + Math.floor(Math.random()*10000), path: '/' + path, method: method, headers: (opts && opts.headers) || {}, body: opts && opts.body ? opts.body : null }); }catch(e){ console.warn('order-outbox: enqueue error', e); }
                    return Promise.reject(err);
                  });
                }

                // default: just forward
                return origFetch(newUrl, opts);
              }
            }
          }
        }catch(e){ /* fall back to original */ }
        return origFetch(input, init);
      };
    }
  }catch(e){}
})();

// Dev-only auto-admin sign-in for local development.
// This will attempt to sign in the default admin user on select admin pages
// when running on localhost/127.0.0.1. The server exposes
// /api/admin/get-admin-custom-token which returns a Firebase custom token for
// the default admin. The endpoint is intentionally restricted to loopback
// requests or requires a DEV_ADMIN_KEY header for safety.
(function(){
  try{
    // Only attempt on pages that are admin UIs
    var adminPages = ['dashboard.html','orders.html','inventory.html','accounts.html','inventory-app.html','add-product.html'];
    try{
      var p = (window.location.pathname || '').split('/').pop() || '';
      if(adminPages.indexOf(p) === -1) return; // not an admin page
    }catch(e){ return; }

    // Only run on loopback host for safety
    var host = (window.location.hostname || '').toLowerCase();
    if(!(host === 'localhost' || host === '127.0.0.1' || host === '::1')) return;

    // Require an explicit opt-in to avoid accidentally signing clients in on public pages.
    // Add this meta tag to admin pages that should auto-signin during local dev:
    // <meta name="shoepao-dev-admin" content="true">
    // Or set window.SHOEPAO_DEV_AUTOADMIN = true in page JS before this script runs.
    try{
      var meta = document.querySelector('meta[name="shoepao-dev-admin"]');
      var metaEnabled = meta && String(meta.content || '').toLowerCase() === 'true';
      var globalEnabled = !!(window.SHOEPAO_DEV_AUTOADMIN === true);
      if(!metaEnabled && !globalEnabled) return; // explicit opt-in required
    }catch(e){ return; }

    // Prevent scheduling this auto-signin logic multiple times in the same page
    if(window.__shoepao_auto_admin_inited) return; window.__shoepao_auto_admin_inited = true;

    // If Firebase isn't present yet, wait a short time and try again
    function attemptAutoSignIn(){
      try{ if(window.__shoepao_auto_admin_attempted) return; window.__shoepao_auto_admin_attempted = true; }catch(e){}
      // If the browser is offline, skip auto-admin sign-in to avoid reload loops
      try{
        if(typeof navigator !== 'undefined' && navigator.onLine === false){
          console.warn('admin auto-signin: navigator reports offline — skipping auto sign-in');
          return;
        }
      }catch(e){}
      try{
        if(!window.firebase || !firebase.auth) return;
        var user = firebase.auth().currentUser;
        if(user) return; // already signed in

        // Request admin custom token from server. This will be rewritten by the
        // fetch monkey-patch above to use API_BASE when needed.
        fetch('/api/admin/get-admin-custom-token', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then(function(resp){
          if(!resp || !resp.ok) return resp.text().then(function(t){ try{ console.warn('admin auto-signin: server refused token', resp && resp.status, t); }catch(e){} });
          return resp.json().then(function(json){
            if(!json || !json.token) return console.warn('admin auto-signin: no token in response');
            try{
              firebase.auth().signInWithCustomToken(json.token).then(function(){
                  try{ sessionStorage.setItem('shoepao_admin_session', '1'); }catch(e){}
                  console.info('admin auto-signin: signed in as', json.email || json.uid);
                  try{
                    // Ensure we only trigger a reload once after an automatic sign-in to avoid reload storms
                    if(!window.__shoepao_auto_admin_signedin){ window.__shoepao_auto_admin_signedin = true; setTimeout(function(){ try{ location.reload(); }catch(e){} }, 800); }
                  }catch(e){ /* ignore */ }
                }).catch(function(err){ console.warn('admin auto-signin: signInWithCustomToken failed', err); });
            }catch(e){ console.warn('admin auto-signin: error signing in', e); }
          }).catch(function(e){ console.warn('admin auto-signin: failed to parse token response', e); });
        }).catch(function(e){ console.warn('admin auto-signin: fetch failed', e); });
      }catch(e){ console.warn('admin auto-signin: unexpected error', e); }
    }

  // Try after a short delay to allow firebase initialisation on the page
  setTimeout(attemptAutoSignIn, 800);
  // And again after 3s in case firebase initialization is slower (guarded inside attemptAutoSignIn)
  setTimeout(attemptAutoSignIn, 3000);
  }catch(e){}
})();

// If this is a client-facing (non-admin) page, proactively clear any admin
// sessions that were created by the dev auto-admin flow. We use a sessionStorage
// marker `shoepao_admin_session` to indicate an admin session intentionally
// created for local admin pages. If the user is signed in and that marker is
// not present, sign out admin users so client pages never show a default account.
(function(){
  try{
    var adminPages = ['dashboard.html','orders.html','inventory.html','accounts.html','inventory-app.html','add-product.html'];
    var p = (window.location.pathname || '').split('/').pop() || '';
    var isAdminPage = adminPages.indexOf(p) !== -1;

    function maybeSignOutAdminOnClientPages(){
      try{
        if(isAdminPage) return;
        if(!window.firebase || !firebase.auth) return;
        var user = firebase.auth().currentUser;
        if(!user) return;
        // Check token claims/email to decide if this is an admin account.
        user.getIdTokenResult().then(function(tr){
          var claims = (tr && tr.claims) ? tr.claims : {};
          var isAdminClaim = !!claims.admin;
          var email = (user.email || '').toLowerCase();
          var adminEmail = (window.SHOEPAO_ADMIN_EMAIL || 'admin@gmail.com').toLowerCase();
          if(isAdminClaim || (email && adminEmail && email === adminEmail)){
            // Always sign out admin sessions on client-facing pages to avoid a default
            // logged-in admin account appearing where it shouldn't.
            try{
              firebase.auth().signOut().then(function(){
                try{ sessionStorage.removeItem('shoepao_admin_session'); }catch(e){}
                try{ localStorage.removeItem('profile'); localStorage.removeItem('authToken'); localStorage.removeItem('client_orders'); localStorage.removeItem('wishlist'); localStorage.removeItem('cart'); }catch(e){}
                try{
                  // Prevent reload storms: only reload once per session when signing out admin on client pages
                  try{ if(sessionStorage && sessionStorage.getItem && sessionStorage.getItem('__shoepao_client_signout_reloaded')) { return; } }catch(_){ }
                  try{ if(sessionStorage && sessionStorage.setItem) sessionStorage.setItem('__shoepao_client_signout_reloaded', '1'); }catch(_){ }
                  location.reload();
                }catch(e){}
              }).catch(function(){});
            }catch(e){}
          }
        }).catch(function(){ /* ignore token fetch errors */ });
      }catch(e){}
    }

    // Run shortly after page load and also when auth state changes.
    try{ setTimeout(maybeSignOutAdminOnClientPages, 1200); }catch(e){}
    if(window.firebase && firebase.auth){
      try{ firebase.auth().onAuthStateChanged(function(){ setTimeout(maybeSignOutAdminOnClientPages, 400); }); }catch(e){}
    }
  }catch(e){}
})();

// --- User session watcher: periodically verify current auth token with server and
// force sign-out + redirect to login.html if server reports the user no longer exists.
(function(){
  try{
    if(typeof window.fetch !== 'function') return;
    var CHECK_INTERVAL = 15000; // 15s
    async function signOutAndRedirect(){
      try{
        // clear common local keys that may contain profile data
        try{ localStorage.removeItem('profile'); localStorage.removeItem('authToken'); localStorage.removeItem('authTokenUpdatedAt'); }catch(e){}
        try{ localStorage.removeItem('client_orders'); localStorage.removeItem('wishlist'); localStorage.removeItem('cart'); }catch(e){}
        if(window.firebase && firebase.auth){
          try{ await firebase.auth().signOut(); }catch(e){}
        }
        try{ sessionStorage.removeItem('shoepao_admin_session'); }catch(e){}
      }catch(e){}
      try{
        // Avoid redirect loops: only navigate once per session
        try{ if(sessionStorage && sessionStorage.getItem && sessionStorage.getItem('__shoepao_signout_redirecting')) { return; } }catch(_){ }
        try{ if(sessionStorage && sessionStorage.setItem) sessionStorage.setItem('__shoepao_signout_redirecting', '1'); }catch(_){ }
        window.location.href = 'login.html';
      }catch(e){}
    }

    async function checkCurrentUser(){
      try{
        if(!window.firebase || !firebase.auth) return;
        var user = firebase.auth().currentUser;
        if(!user) return; // not signed in
        var idToken = null;
        try{
          // Try a forced refresh first, but on transient failures fall back to the cached token
          idToken = await user.getIdToken(true);
        }catch(e){
          try{
            // fallback: try to get a cached token without forcing refresh
            idToken = await user.getIdToken();
          }catch(e2){
            // Both attempts failed — don't force sign-out here. This can happen during
            // a reload when auth hasn't fully initialized or network is flaky. Wait
            // for the next periodic check instead of immediately signing the user out.
            try{ if(typeof console !== 'undefined' && console.warn) console.warn('verify-session: getIdToken failed (both forced and cached)', e, e2); }catch(_){}
            return;
          }
        }
        if(!idToken){ return; }

        var base = String(window.API_BASE || '/server-proxy.php').replace(/\/+$/,'');
        var verifyUrl = base + '/api/verify-user';
        try{
          var resp = await window.fetch(verifyUrl, { method: 'POST', headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' } });
          if(!resp || !resp.ok){
            // if server returns 401 or non-ok, force sign-out
            await signOutAndRedirect();
            return;
          }
          // server ok -> nothing to do
        }catch(e){
          // network error: do nothing (don't sign out on transient network failures)
          // but log for debugging
          try{ if(typeof console !== 'undefined' && console.debug) console.debug('verify-session: network error', e); }catch(_){}
        }
      }catch(e){ /* ignore */ }
    }

    try{
      setInterval(checkCurrentUser, CHECK_INTERVAL);
      // also run once on load after short delay so token refresh can happen
      setTimeout(checkCurrentUser, 3000);
    }catch(e){}
  }catch(e){}
})();
