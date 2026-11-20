/* GoTAB navigation helpers: back to the page you came from, log out, skip login when already signed in */
(function () {
  var AUTH = /^\/(index\.html|login\.html|register\.html)?$/;
  function sameOriginReferrer(skipAuth) {
    try {
      var u = new URL(document.referrer);
      return !!document.referrer && u.origin === location.origin && u.pathname !== location.pathname && !(skipAuth && AUTH.test(u.pathname));
    } catch (e) { return false; }
  }
  // Back: the previous page of this site if there is one, otherwise a sensible fallback
  window.goBack = function (fallback, skipAuth) {
    if (window.goBackHook && window.goBackHook()) return;   // a page can close its own open view first
    if (sameOriginReferrer(skipAuth) && history.length > 1) { history.back(); return; }
    location.href = fallback || 'index.html';
  };
  window.goLogout = async function () {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    try { Object.keys(localStorage).forEach(function (k) { if (/^gotab_act_/.test(k)) localStorage.removeItem(k); }); } catch (e) {}
    location.href = 'index.html';
  };
  // Signed-in users skip the landing / login / register pages and go straight to their cabinet
  window.goSkipIfSignedIn = async function () {
    try {
      var r = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
      var j = await r.json();
      var u = j && j.user;
      if (!u) return false;
      location.replace(u.role === 'admin' ? 'admin.html' : 'dashboard.html');
      return true;
    } catch (e) { return false; }
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-go-back]');
    if (b) { e.preventDefault(); e.stopImmediatePropagation(); window.goBack(b.getAttribute('data-go-back'), b.hasAttribute('data-go-back-auto')); return; }
    var o = e.target.closest && e.target.closest('[data-go-logout]');
    if (o) { e.preventDefault(); e.stopImmediatePropagation(); window.goLogout(); }
  }, true);
  function autoHide() {
    if (sameOriginReferrer(true)) return;
    document.querySelectorAll('[data-go-back-auto]').forEach(function (el) { el.style.display = 'none'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoHide); else autoHide();
})();
