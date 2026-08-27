// ============================================================================
// Landing-page behaviour: language switching, scroll reveal, phone tilt, dock.
//
// This replaces the design-canvas runtime (React from unpkg + support.js +
// image-slot.js, ~180 kB across three third-party requests) that used to render
// the page. That mattered for more than weight: the whole page lived inside an
// <x-dc> template whose text was `{{ t.* }}` placeholders, so the HTML a
// crawler downloaded contained no copy, no <title> and no description — the
// exact shape Search Console reports as a soft 404.
//
// Now the markup ships finished and in Polish. Everything here is progressive
// enhancement: with JS off the page is still complete, just monolingual.
// ============================================================================

(function () {
  'use strict';

  var STORE_KEY = 'plately_landing_lang';
  var DEFAULT_LANG = 'pl';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var dict = window.PLATELY_I18N || {};
  var langs = window.PLATELY_LANGS || [];

  // --------------------------------------------------------------------------
  // Language
  // --------------------------------------------------------------------------

  function savedLang() {
    try {
      return localStorage.getItem(STORE_KEY);
    } catch (e) {
      // Storage blocked (private mode, cookie-blocking extension). Not fatal —
      // the choice just will not survive a reload.
      return null;
    }
  }

  function initialLang() {
    var saved = savedLang();
    if (saved && dict[saved]) return saved;
    var nav = (navigator.language || DEFAULT_LANG).slice(0, 2).toLowerCase();
    return dict[nav] ? nav : DEFAULT_LANG;
  }

  function setMeta(selector, value) {
    if (!value) return;
    var el = document.head.querySelector(selector);
    if (el) el.setAttribute('content', value);
  }

  function applyLang(code) {
    var t = dict[code];
    if (!t) return;

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var value = t[el.getAttribute('data-i18n')];
      if (typeof value === 'string') el.textContent = value;
    });

    document.documentElement.lang = code;

    // The head is part of the translation too: leaving a Polish <title> on a
    // page the reader switched to Korean is the kind of detail that reads as
    // broken rather than as "not translated yet".
    if (t.metaTitle) document.title = t.metaTitle;
    setMeta('meta[name="description"]', t.metaDesc);
    setMeta('meta[property="og:title"]', t.metaTitle);
    setMeta('meta[property="og:description"]', t.metaDesc);
    setMeta('meta[name="twitter:title"]', t.metaTitle);
    setMeta('meta[name="twitter:description"]', t.metaDesc);

    var codeEl = document.getElementById('pl-langcode');
    if (codeEl) codeEl.textContent = code;

    document.querySelectorAll('#pl-langlist [data-lang]').forEach(function (btn) {
      btn.setAttribute('aria-current', btn.getAttribute('data-lang') === code ? 'true' : 'false');
    });
  }

  function chooseLang(code) {
    try {
      localStorage.setItem(STORE_KEY, code);
    } catch (e) {}
    applyLang(code);
    closeMenu();
  }

  // --------------------------------------------------------------------------
  // Language menu
  // --------------------------------------------------------------------------

  var btn = document.getElementById('pl-langbtn');
  var menu = document.getElementById('pl-langmenu');
  var list = document.getElementById('pl-langlist');

  function menuOpen() {
    return menu && !menu.hidden;
  }

  function openMenu() {
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!menu || !btn) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  if (list && langs.length) {
    langs.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-langopt';
      b.setAttribute('data-lang', l.code);
      b.setAttribute('lang', l.code);
      b.setAttribute('aria-current', 'false');

      var code = document.createElement('span');
      code.style.cssText = "font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; text-transform:uppercase; opacity:.65;";
      code.textContent = l.code;

      b.appendChild(code);
      b.appendChild(document.createTextNode(' ' + l.label));
      b.addEventListener('click', function () {
        chooseLang(l.code);
      });
      list.appendChild(b);
    });
  }

  if (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuOpen()) closeMenu();
      else openMenu();
    });
  }

  document.addEventListener('click', function (e) {
    if (!menuOpen()) return;
    if (e.target.closest('#pl-langmenu') || e.target.closest('#pl-langbtn')) return;
    closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menuOpen()) {
      closeMenu();
      if (btn) btn.focus();
    }
  });

  applyLang(initialLang());

  // --------------------------------------------------------------------------
  // Scroll reveal
  // --------------------------------------------------------------------------

  var revealables = document.querySelectorAll('.pl-reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealables.forEach(function (el) {
      el.classList.add('pl-in');
    });
  } else {
    var n = 0;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          setTimeout(function () {
            el.classList.add('pl-in');
          }, (n++ % 5) * 90);
          io.unobserve(el);
        });
      },
      { threshold: 0.05, rootMargin: '0px 0px -6% 0px' }
    );
    revealables.forEach(function (el) {
      io.observe(el);
    });

    // Belt and braces: an element already on screen at load, or one the
    // observer misses during a fast scroll, would otherwise stay invisible
    // forever — a blank section is far worse than a missing animation.
    var sweep = function () {
      document.querySelectorAll('.pl-reveal:not(.pl-in)').forEach(function (el) {
        if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('pl-in');
      });
    };
    window.addEventListener('scroll', sweep, { passive: true });
    window.addEventListener('load', sweep);
    setTimeout(sweep, 900);
  }

  // --------------------------------------------------------------------------
  // Phone tilt — pointer parallax, desktop only
  // --------------------------------------------------------------------------

  var phone = document.getElementById('pl-phone');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (phone && finePointer && !reduceMotion) {
    window.addEventListener('mousemove', function (ev) {
      if (window.innerWidth < 900) return;
      var cx = window.innerWidth / 2;
      var cy = window.innerHeight / 2;
      phone.style.animation = 'none';
      phone.style.transform =
        'perspective(1400px) rotateX(' + (((ev.clientY - cy) / cy) * -5) + 'deg) rotateY(' + (((ev.clientX - cx) / cx) * 6) + 'deg)';
    });
  }

  // --------------------------------------------------------------------------
  // Floating dock — appears once the hero CTA has scrolled away, hides again
  // when the real download card comes into view so the two never compete.
  // --------------------------------------------------------------------------

  var dock = document.getElementById('pl-dock');
  var cta = document.getElementById('pobierz');

  if (dock) {
    var onScroll = function () {
      var nearCta = cta && cta.getBoundingClientRect().top < window.innerHeight * 0.9;
      var show = window.scrollY > 420 && !nearCta;
      dock.style.opacity = show ? '1' : '0';
      dock.style.transform = show ? 'none' : 'translateY(16px)';
      dock.style.pointerEvents = show ? 'auto' : 'none';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
