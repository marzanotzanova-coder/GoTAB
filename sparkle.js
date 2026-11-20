/* GoTAB sparkle layer: soft twinkling stars + a glitter trail that follows the mouse or finger.
   Usage: GoSparkle(element, { ambient: 26, trail: true }) — draws on a canvas inside the element. */
(function () {
  var COLORS = ['#2F6BFF', '#20C9FF', '#7FB2FF', '#ffffff', '#A9C8FF', '#5ED6FF'];
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function star(g, x, y, r, rot) {
    g.save(); g.translate(x, y); g.rotate(rot); g.beginPath();
    for (var i = 0; i < 4; i++) {
      g.quadraticCurveTo(0, 0, r, 0);
      g.rotate(Math.PI / 4); g.quadraticCurveTo(r * 0.12, r * 0.12, r * 0.3, 0);
      g.rotate(Math.PI / 4);
    }
    g.closePath(); g.fill();
    g.globalAlpha *= 0.9; g.fillStyle = '#ffffff'; g.beginPath(); g.arc(0, 0, r * 0.16, 0, 6.283); g.fill();
    g.restore();
  }

  window.GoSparkle = function (el, opt) {
    if (!el || el.__goSparkle) return;
    opt = opt || {};
    el.__goSparkle = true;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    var cv = document.createElement('canvas');
    cv.className = 'go-sparkle-canvas';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:' + (opt.z == null ? 0 : opt.z) + ';border-radius:inherit';
    el.insertBefore(cv, el.firstChild);
    var g = cv.getContext('2d'), W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size() { var r = el.getBoundingClientRect(); W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0); }
    size();
    if (window.ResizeObserver) new ResizeObserver(size).observe(el); else window.addEventListener('resize', size);

    var amb = [], parts = [], n = reduce ? 0 : (opt.ambient == null ? 22 : opt.ambient);
    for (var i = 0; i < n; i++) amb.push({ x: Math.random(), y: Math.random(), r: 4 + Math.random() * 6, ph: Math.random() * 6.28, sp: 0.6 + Math.random() * 1.4, c: COLORS[i % COLORS.length], dy: 0.004 + Math.random() * 0.01 });

    var last = 0;
    function spawn(x, y, k) {
      for (var i = 0; i < k; i++) {
        var a = Math.random() * 6.28, s = 0.4 + Math.random() * 1.6;
        parts.push({ x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.6, r: 6 + Math.random() * 8, life: 1, dec: 0.012 + Math.random() * 0.02, rot: Math.random() * 3, vr: (Math.random() - 0.5) * 0.2, c: COLORS[(Math.random() * COLORS.length) | 0] });
      }
      if (parts.length > 260) parts.splice(0, parts.length - 260);
    }
    if (opt.trail !== false && !reduce) {
      el.addEventListener('pointermove', function (e) {
        var now = performance.now(); if (now - last < 16) return; last = now;
        var r = el.getBoundingClientRect(); spawn(e.clientX - r.left, e.clientY - r.top, e.pointerType === 'touch' ? 3 : 2);
      }, { passive: true });
      el.addEventListener('pointerdown', function (e) { var r = el.getBoundingClientRect(); spawn(e.clientX - r.left, e.clientY - r.top, 14); }, { passive: true });
    }

    var t0 = performance.now();
    function frame(now) {
      var t = (now - t0) / 1000;
      g.clearRect(0, 0, W, H);
      for (var i = 0; i < amb.length; i++) {
        var s = amb[i], tw = 0.5 + 0.5 * Math.sin(t * s.sp + s.ph);
        var y = ((s.y - t * s.dy) % 1 + 1) % 1;
        g.globalAlpha = 0.25 + 0.65 * tw; g.fillStyle = s.c;
        g.shadowColor = s.c === '#ffffff' ? '#7FB2FF' : s.c; g.shadowBlur = 12;
        star(g, s.x * W, y * H, s.r * (0.6 + 0.6 * tw), t * 0.3 + s.ph);
      }
      for (var j = parts.length - 1; j >= 0; j--) {
        var p = parts[j];
        p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.vx *= 0.98; p.rot += p.vr; p.life -= p.dec;
        if (p.life <= 0) { parts.splice(j, 1); continue; }
        g.globalAlpha = Math.min(1, p.life * 1.4); g.fillStyle = p.c;
        g.shadowColor = p.c === '#ffffff' ? '#7FB2FF' : p.c; g.shadowBlur = 14;
        star(g, p.x, p.y, p.r * (0.4 + 0.6 * p.life), p.rot);
      }
      g.globalAlpha = 1; g.shadowBlur = 0;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };
})();
