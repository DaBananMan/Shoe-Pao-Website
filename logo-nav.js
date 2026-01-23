// logo-nav.js
// Attach click handlers to ShoePao logo images to navigate to the last viewed product (if any)
(function(){
  function goToLastProductOrHome(e){
    if(e && e.preventDefault) e.preventDefault();
    try{
      var title = localStorage.getItem('productTitle');
      if(title && title.trim().length>0){
        window.location.href = 'product-view.html';
        return;
      }
    }catch(e){}
    // fallback
    if (location.pathname && location.pathname.indexOf('dashboard')!==-1){
      // if admin area, go to dashboard
      window.location.href = 'dashboard.html';
    } else {
      // default client landing
      window.location.href = 'product-list.html';
    }
  }

  function attach(){
    // match logo images by filename or alt text
    var imgs = Array.from(document.querySelectorAll('img')).filter(function(img){
      var src = (img.getAttribute('src')||'').toLowerCase();
      var alt = (img.getAttribute('alt')||'').toLowerCase();
      return src.indexOf('shoeppao')!==-1 || src.indexOf('shoepao')!==-1 || alt.indexOf('shoepao')!==-1 || alt.indexOf('shoepao')!==-1;
    });
    imgs.forEach(function(img){
      img.style.cursor = 'pointer';
      img.addEventListener('click', goToLastProductOrHome);
      // if wrapped in a link, override the link click too
      var a = img.closest('a');
      if(a) a.addEventListener('click', goToLastProductOrHome);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
