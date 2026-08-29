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
// Now the markup ships finished — and, since scripts/build-pages.mjs bakes the
// copy in, finished in whichever of the twelve languages the URL asks for.
// Everything here is progressive enhancement: with JS off the page is still
// complete.
//
// The dictionaries used to ship to the browser (58 kB across two files) so this
// script could swap the text after load. That cost every visitor the download
// and left Google with one indexable page for twelve translations, because the
// other eleven only ever existed after JavaScript ran. Both problems go away
// when each language is its own URL: the text is already correct on arrival,
// and the switcher below is a set of ordinary links.
// ============================================================================

(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Kept here rather than in a dictionary file: twelve labels are cheaper to
  // inline than another request, and this is all the switcher needs.
  var LANGS = [
    { code: 'pl', label: 'Polski' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'uk', label: 'Українська' },
    { code: 'ru', label: 'Русский' },
    { code: 'fr', label: 'Français' },
    { code: 'it', label: 'Italiano' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'ja', label: '日本語' },
    { code: 'zh', label: '中文' },
    { code: 'ko', label: '한국어' }
  ];

  // Polish is the site root, so it has no prefix; everything else is /<code>,
  // with no trailing slash — vercel.json sets trailingSlash:false, so /en/ would
  // 308 to /en. This must agree with scripts/build-pages.mjs, the sitemap and
  // the hreflang block, or the four will disagree about where a language lives.
  function hrefFor(code) {
    return code === 'pl' ? '/' : '/' + code;
  }

  var currentLang = document.documentElement.lang || 'pl';

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

  // Anchors, not buttons. A crawler follows these and finds the other eleven
  // translations; a reader gets a URL they can bookmark and share, and the
  // choice survives a cleared localStorage because it is in the address.
  if (list) {
    LANGS.forEach(function (l) {
      var a = document.createElement('a');
      a.className = 'pl-langopt';
      a.href = hrefFor(l.code);
      a.setAttribute('lang', l.code);
      a.setAttribute('hreflang', l.code);
      a.setAttribute('aria-current', l.code === currentLang ? 'true' : 'false');

      var code = document.createElement('span');
      code.style.cssText = "font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; text-transform:uppercase; opacity:.65;";
      code.textContent = l.code;

      a.appendChild(code);
      a.appendChild(document.createTextNode(' ' + l.label));
      list.appendChild(a);
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
  // from the pricing section down. Every screen below that point already has a
  // real button on it, and on a phone the dock sits exactly on top of the
  // "choose plan" button of whichever card is in view.
  // --------------------------------------------------------------------------

  var dock = document.getElementById('pl-dock');
  var stoppers = ['cennik', 'pobierz']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  if (dock) {
    var reached = function (el) {
      return el.getBoundingClientRect().top < window.innerHeight * 0.9;
    };
    var onScroll = function () {
      var show = window.scrollY > 420 && !stoppers.some(reached);
      dock.style.opacity = show ? '1' : '0';
      dock.style.transform = show ? 'none' : 'translateY(16px)';
      dock.style.pointerEvents = show ? 'auto' : 'none';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
