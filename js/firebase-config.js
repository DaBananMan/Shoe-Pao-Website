// Shared Firebase web config for the site.
// Replace these values with your project's actual config if you recreate the web app in Firebase Console.
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyDf1LltQfn3_AXmV1-gpm2SWOTInXfIdgY",
  authDomain: "shoe-pao-special.firebaseapp.com",
  projectId: "shoe-pao-special",
  storageBucket: "shoe-pao-special.firebasestorage.app",
  messagingSenderId: "590509920226",
  appId: "1:590509920226:web:9daf77b2841e3d699633bb",
  measurementId: "G-JD4WGCKFQC"
};

// PageDataGate: shared gate that blocks the page until data is ready.
// - call PageDataGate.block(text) to show the loader and hide content
// - call PageDataGate.ready() when data is ready (or PageDataGate.error(msg) on failure)
// - or use PageDataGate.wrap(promise, text) to block until a promise resolves
(function(){
  if(window.PageDataGate) return;

  var state = { blocked: false };

  function ensureStyles(){
    if(document.getElementById('pageGateStyles')) return;
    var style = document.createElement('style');
    style.id = 'pageGateStyles';
    style.textContent = [
      'html.page-gate-blocked, body.page-gate-blocked { overflow: hidden !important; }',
      'body.page-gate-blocked > *:not(.page-loader) { opacity: 0; pointer-events: none; }',
      'body.page-gate-blocked #pageShell { opacity: 0; pointer-events: none; }',
      'body.page-gate-ready #pageShell { opacity: 1; pointer-events: auto; }',
      'body.page-gate-ready .page-loader { display: none !important; }',
      '.page-loader { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; background: #fff; z-index: 1300; }',
      '.page-loader__spinner { width: 32px; height: 32px; border: 3px solid #e0e0e0; border-top-color: #b71c1c; border-radius: 50%; animation: page-spin 0.85s linear infinite; }',
      '.page-loader__text { font-size: 1rem; color: #222; }',
      '@keyframes page-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function ensureLoader(text){
    var loader = document.getElementById('pageLoader');
    if(!loader){
      loader = document.createElement('div');
      loader.id = 'pageLoader';
      loader.className = 'page-loader';
      var spinner = document.createElement('div');
      spinner.className = 'page-loader__spinner';
      var txt = document.createElement('div');
      txt.id = 'pageLoaderText';
      txt.className = 'page-loader__text';
      txt.textContent = text || 'Loading data...';
      loader.appendChild(spinner);
      loader.appendChild(txt);
      document.body.insertBefore(loader, document.body.firstChild || null);
    } else {
      var textEl = document.getElementById('pageLoaderText') || loader.querySelector('.page-loader__text');
      if(textEl && text) textEl.textContent = text;
    }
    loader.style.display = 'flex';
    return loader;
  }

  function block(text){
    ensureStyles();
    var loader = ensureLoader(text || 'Loading data...');
    state.blocked = true;
    document.documentElement.classList.add('page-gate-blocked');
    document.body.classList.add('page-gate-blocked');
    if(loader) loader.removeAttribute('aria-hidden');
    var shell = document.getElementById('pageShell');
    if(shell) shell.setAttribute('aria-hidden', 'true');
  }

  function ready(){
    if(!state.blocked) return;
    state.blocked = false;
    document.documentElement.classList.remove('page-gate-blocked');
    document.body.classList.remove('page-gate-blocked');
    document.body.classList.add('page-gate-ready');
    var shell = document.getElementById('pageShell');
    if(shell) shell.removeAttribute('aria-hidden');
    var loader = document.getElementById('pageLoader');
    if(loader) loader.style.display = 'none';
  }

  function error(msg){
    var t = document.getElementById('pageLoaderText');
    if(t && msg) t.textContent = msg;
    ready();
  }

  function wrap(promiseOrFn, text){
    block(text);
    var p = (typeof promiseOrFn === 'function') ? promiseOrFn() : promiseOrFn;
    return Promise.resolve(p).then(function(res){ ready(); return res; }).catch(function(err){ error('Unable to load data.'); throw err; });
  }

  function autoBlock(){
    if(!document.body) return;
    if(document.body.classList.contains('page-loading')){
      var tEl = document.getElementById('pageLoaderText');
      var txt = (tEl && tEl.textContent) ? tEl.textContent : 'Loading data...';
      block(txt);
    }
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive') autoBlock();
  else document.addEventListener('DOMContentLoaded', autoBlock);

  window.PageDataGate = { block: block, ready: ready, error: error, wrap: wrap };
})();
