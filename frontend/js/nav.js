(function () {
  function closeBar(bar, toggle) {
    bar.classList.remove('nav-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function init() {
    var bars = document.querySelectorAll('.navbar');
    for (var i = 0; i < bars.length; i++) {
      (function (bar) {
        var toggle = bar.querySelector('.nav-toggle');
        if (!toggle) return;

        toggle.addEventListener('click', function () {
          var open = bar.classList.toggle('nav-open');
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        var links = bar.querySelectorAll('.nav-links a, .subnav a');
        for (var j = 0; j < links.length; j++) {
          links[j].addEventListener('click', function () { closeBar(bar, toggle); });
        }
      })(bars[i]);
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = document.querySelectorAll('.navbar.nav-open');
      for (var k = 0; k < open.length; k++) closeBar(open[k], open[k].querySelector('.nav-toggle'));
    });

    document.addEventListener('click', function (e) {
      var open = document.querySelectorAll('.navbar.nav-open');
      for (var k = 0; k < open.length; k++) {
        if (!open[k].contains(e.target)) closeBar(open[k], open[k].querySelector('.nav-toggle'));
      }
    });
  }

  // Register the service worker on every page (nav.js loads everywhere).
  // It caches CSS/JS/images so the site keeps working — and opens instantly —
  // on very weak connections or when briefly offline. Pages that already
  // register it inline are unaffected; register() is idempotent.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
