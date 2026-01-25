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

    // Compute a safe API_BASE similar to pages so relative '/api/...' requests can be rewritten
    if(!window.API_BASE){
      try{
        var p = window.location.pathname.replace(/\/+$|^\/+/, '');
        var seg = p.split('/');
        var root = seg.length > 0 ? '/' + seg[0] : '';
        window.API_BASE = root + '/server-proxy.php';
      }catch(e){ window.API_BASE = '/server-proxy.php'; }
    }

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
