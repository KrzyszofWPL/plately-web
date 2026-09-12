/* ==========================================================================
   Confetti for the two moments that deserve it: a card paid for, a gift
   unwrapped. One canvas over the page, a few hundred pieces of paper in the
   brand's colours falling for three seconds, then gone — no library, nothing
   left in the DOM afterwards. `PlatelyConfetti.burst()` fires it; a system
   set to reduced motion gets nothing, which is what it asked for.
   ========================================================================== */
(function (root) {
  "use strict";

  var COLOURS = ["#34d399", "#8cf7c3", "#0b845a", "#ffe38a", "#f5c542", "#ffffff", "#b40000", "#ff6b6b"];

  function burst(opts) {
    if (typeof document === "undefined") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var o = opts || {};
    var count = o.count || 220, duration = o.duration || 3200;

    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
    document.body.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W, H;
    function size() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener("resize", size);

    // Two cannons, one from each bottom corner, aimed at the middle of the
    // screen — reads as a celebration rather than as weather.
    var pieces = [];
    for (var i = 0; i < count; i++) {
      var left = i % 2 === 0;
      var angle = (left ? -60 : -120) * Math.PI / 180 + (Math.random() - .5) * .9;
      var speed = 9 + Math.random() * 9;
      pieces.push({
        x: left ? W * .08 : W * .92, y: H * .92,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6, h: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * .3,
        colour: COLOURS[i % COLOURS.length],
        wobble: Math.random() * Math.PI * 2, wobbleSpeed: .05 + Math.random() * .1,
        delay: Math.random() * 250
      });
    }

    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = now - start;
      ctx.clearRect(0, 0, W, H);
      var alive = 0;
      var fade = t > duration - 700 ? Math.max(0, (duration - t) / 700) : 1;
      for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        if (t < p.delay) { alive++; continue; }
        p.vy += .32;              // gravity
        p.vx *= .985; p.vy *= .985; // drag
        p.wobble += p.wobbleSpeed;
        p.x += p.vx + Math.sin(p.wobble) * .8;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y < H + 20) alive++;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.abs(Math.cos(p.wobble)) * .8 + .2); // paper turning in the air
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < duration && alive > 0) requestAnimationFrame(frame);
      else { window.removeEventListener("resize", size); canvas.remove(); }
    }
    requestAnimationFrame(frame);
  }

  root.PlatelyConfetti = { burst: burst };
})(typeof self !== "undefined" ? self : this);
