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

  // --------------------------------------------------------------------------
  // Flags, drawn rather than typed.
  //
  // The switcher showed the two-letter code in a monospace face because the
  // obvious alternative -- a regional-indicator emoji pair -- is not rendered
  // by Windows at all: Segoe UI Emoji has never carried flag glyphs, and the
  // browser falls back to drawing the pair as its two letters. So both options
  // put "PL" on screen, and the one that at least looked deliberate won.
  // Drawing them is the third option, and the only one that looks the same in
  // every browser.
  //
  // Deliberately simplified: at 18 pixels wide, the American stars and the
  // Korean trigrams are a smudge. Each flag keeps the marks that identify it
  // at a glance and drops the rest -- and every one sits beside the language's
  // own name, which is what actually labels it.
  // --------------------------------------------------------------------------
  var FLAGS = {
    pl: '<rect width="24" height="16" fill="#fff"/><rect y="8" width="24" height="8" fill="#dc143c"/>',
    en: '<rect width="24" height="16" fill="#fff"/><g fill="#b22234"><rect y="0" width="24" height="1.23"/><rect y="2.46" width="24" height="1.23"/><rect y="4.92" width="24" height="1.23"/><rect y="7.38" width="24" height="1.23"/><rect y="9.85" width="24" height="1.23"/><rect y="12.31" width="24" height="1.23"/><rect y="14.77" width="24" height="1.23"/></g><rect width="10" height="8.61" fill="#3c3b6e"/><g fill="#fff"><circle cx="2.6" cy="2.3" r=".75"/><circle cx="5.6" cy="2.3" r=".75"/><circle cx="7.9" cy="4.4" r=".75"/><circle cx="2.6" cy="6.4" r=".75"/><circle cx="5.6" cy="6.4" r=".75"/></g>',
    de: '<rect width="24" height="5.34" fill="#000"/><rect y="5.34" width="24" height="5.33" fill="#dd0000"/><rect y="10.67" width="24" height="5.33" fill="#ffce00"/>',
    uk: '<rect width="24" height="8" fill="#0057b7"/><rect y="8" width="24" height="8" fill="#ffd700"/>',
    ru: '<rect width="24" height="5.34" fill="#fff"/><rect y="5.34" width="24" height="5.33" fill="#0039a6"/><rect y="10.67" width="24" height="5.33" fill="#d52b1e"/>',
    fr: '<rect width="8" height="16" fill="#002395"/><rect x="8" width="8" height="16" fill="#fff"/><rect x="16" width="8" height="16" fill="#ed2939"/>',
    it: '<rect width="8" height="16" fill="#009246"/><rect x="8" width="8" height="16" fill="#fff"/><rect x="16" width="8" height="16" fill="#ce2b37"/>',
    es: '<rect width="24" height="16" fill="#aa151b"/><rect y="4" width="24" height="8" fill="#f1bf00"/>',
    pt: '<rect width="24" height="16" fill="#da291c"/><rect width="9.6" height="16" fill="#046a38"/><circle cx="9.6" cy="8" r="3.4" fill="#ffe900" stroke="#046a38" stroke-width=".6"/><circle cx="9.6" cy="8" r="2" fill="#da291c"/>',
    ja: '<rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4.6" fill="#bc002d"/>',
    zh: '<rect width="24" height="16" fill="#ee1c25"/><g fill="#ffde00"><circle cx="5" cy="4.4" r="2.1"/><circle cx="9.4" cy="1.9" r=".8"/><circle cx="11.3" cy="4" r=".8"/><circle cx="11.1" cy="6.9" r=".8"/><circle cx="9" cy="8.7" r=".8"/></g>',
    ko: '<rect width="24" height="16" fill="#fff"/><path d="M12 3.6a4.4 4.4 0 0 1 0 8.8 2.2 2.2 0 0 1 0-4.4 2.2 2.2 0 0 0 0-4.4z" fill="#cd2e3a"/><path d="M12 3.6a4.4 4.4 0 0 0 0 8.8 2.2 2.2 0 0 0 0-4.4 2.2 2.2 0 0 1 0-4.4z" fill="#0047a0"/><g fill="#111" opacity=".85"><rect x="2.4" y="3.4" width="3.4" height=".9"/><rect x="2.4" y="11.7" width="3.4" height=".9"/><rect x="18.2" y="3.4" width="3.4" height=".9"/><rect x="18.2" y="11.7" width="3.4" height=".9"/></g>'
  };

  // Built from the fixed table above. No input reaches this, and nothing that
  // does not appear in FLAGS can be drawn by it.
  function flagNode(code, width) {
    var span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.style.cssText =
      'display:inline-block; flex:none; width:' + width + 'px; height:' + Math.round(width * 2 / 3) +
      'px; border-radius:2px; overflow:hidden; box-shadow:0 0 0 1px rgba(255,255,255,.22);';
    span.innerHTML =
      '<svg viewBox="0 0 24 16" width="100%" height="100%" focusable="false" role="presentation">' +
      (FLAGS[code] || '<rect width="24" height="16" fill="#3f3f46"/>') + '</svg>';
    return span;
  }

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

      a.appendChild(flagNode(l.code, 18));
      a.appendChild(document.createTextNode(l.label));
      list.appendChild(a);
    });
  }

  // The button gets the current language's flag beside its code. Both, not one:
  // the flag is recognised faster, the code is unambiguous, and together they
  // survive the case where a reader does not associate a country with a
  // language they speak.
  var flagSlot = document.getElementById('pl-langflag');
  if (flagSlot) flagSlot.appendChild(flagNode(currentLang, 16));

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
