(function () {
  if (sessionStorage.getItem('semacheck_cookie_consent')) return;

  var banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML =
    '<div class="cookie-banner-text">' +
      'SemaCheck uses only session storage (not tracking cookies) to keep you logged in. ' +
      'We do not use analytics, advertising, or third-party tracking cookies. ' +
      'Read our <a href="privacy.html">Privacy Policy</a> for full details.' +
    '</div>' +
    '<div class="cookie-banner-actions">' +
      '<button class="btn btn-ghost" id="cookieDecline">Decline</button>' +
      '<button class="btn btn-primary" id="cookieAccept">Accept</button>' +
    '</div>';

  document.body.appendChild(banner);

  function dismiss() {
    sessionStorage.setItem('semacheck_cookie_consent', '1');
    banner.classList.add('hidden');
  }

  document.getElementById('cookieAccept').addEventListener('click', dismiss);
  document.getElementById('cookieDecline').addEventListener('click', dismiss);
})();
