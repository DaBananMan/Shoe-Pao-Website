// ensure-server.js
// Lightweight client-side helper to trigger the PHP proxy to start the Node server.
// It avoids spamming by caching the last successful ping in localStorage for a short TTL.
(function(){
  try{
    if(!window.fetch || !window.localStorage) return;
    var KEY = 'shoepao_last_api_ping_v1';
    var TTL = 60 * 1000; // 60 seconds between attempts per browser
    var last = Number(localStorage.getItem(KEY) || 0);
    if(Date.now() - last < TTL) return; // recently pinged

    // Detect if the site is hosted under a folder like /SHOEPAO
    var seg = (window.location.pathname || '').split('/');
    var base = '';
    if(seg.length > 1 && seg[1] && seg[1].toLowerCase() === 'shoepao') base = '/' + seg[1];

    var url = base + '/api/health';
    // Best-effort ping; if server responds OK, cache the time so we don't ping again soon.
    fetch(url, { method: 'GET', cache: 'no-store', mode: 'same-origin' }).then(function(res){
      if(res && res.ok){
        try{ localStorage.setItem(KEY, String(Date.now())); }catch(e){}
      }
    }).catch(function(){ /* ignore errors */ });
  }catch(e){}
})();
