/* ==========================================================================
   Plately Support — the panel behind /support.

   Plain DOM on purpose. The rest of this site is static HTML built by a Node
   script and served with a tight Content-Security-Policy; adding a framework
   would mean a bundler, a build step and a widened CSP for one internal page.
   Everything below is rendered by string templates and driven by delegated
   events, which is enough for a desk this size and keeps the page dependency
   free.

   Anything a role may not do is missing from the DOM *and* refused by the API.
   The first is courtesy; the second is the actual rule.
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("root");
  var overlay = document.getElementById("overlay");

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------

  var S = {
    // The sign-in walks these in order and cannot skip one: the server decides
    // which comes next and the browser only draws it.
    phase: "loading", // loading | signed_out | pin_setup | pin_required |
                      // totp_setup | totp_required | ready
    auth: {},
    staff: null,
    perms: {},
    screen: "inbox", // inbox | tickets | customers | reports | kb | settings
    view: "all_open",
    sort: "age",
    search: "",
    tickets: [],
    counts: {},
    selectedId: null,
    detail: null,
    drafts: {},
    composerKind: "reply",
    inboxOpen: true,
    macros: [],
    team: [],
    settings: null,
    tags: [],
    statuses: [],
    priorities: [],
    customers: null,
    allTickets: null,
    reports: null,
    articles: null,
    staffList: null,
    maintenance: null,
    mailConfigured: true,
    aiConfigured: false,
    // The draft currently on screen, per ticket: { id, text, model, articlesUsed,
    // rating }. Keyed by ticket so switching away and back does not lose it.
    aiDrafts: {},
    aiBusy: false,
    busy: false,
    listBusy: false,
    error: "",
    notice: "",
    turnstile: { siteKey: null, token: null, widget: null },
    // Filled by /api/staff/totp-enrol on a first run: the QR to scan and the
    // same secret in a form that can be typed or pasted.
    enrol: null,
    enrolBusy: false,
    showSecret: false,
  };

  var VIEWS = [
    { key: "all_open", label: "All open", count: "open" },
    { key: "mine", label: "Assigned to me", count: "mine" },
    { key: "unassigned", label: "Unassigned", count: "unassigned" },
    { key: "urgent", label: "Urgent", count: "urgent" },
    { key: "overdue", label: "Waiting over 24h", count: "overdue" },
    { key: "billing", label: "Billing", count: "billing" },
    { key: "bug", label: "Bugs", count: "bug" },
    { key: "feature", label: "Feature requests", count: "feature" },
    { key: "pending", label: "Pending", count: "pending" },
    { key: "solved_today", label: "Solved today", count: "solved_today" },
    { key: "spam", label: "Spam", count: "spam" },
  ];

  var SCREEN_TITLES = {
    inbox: ["Inbox", "Every customer e-mail, one shared queue"],
    tickets: ["All tickets", "Everything the desk has ever seen"],
    customers: ["Customers", "Who writes in, and what they pay for"],
    reports: ["Reports", "Volume, speed and where the load sits"],
    kb: ["Knowledge base", "Articles agents link to in replies"],
    settings: ["Settings", "Your profile, the desk, the site"],
  };

  var SHORTCUTS = [
    { key: "/", label: "Focus search" },
    { key: "N", label: "New ticket" },
    { key: "J / K", label: "Next / previous ticket" },
    { key: "R", label: "Reply · M internal note" },
    { key: "A", label: "Assign the open ticket to me" },
    { key: "E", label: "Mark the open ticket solved" },
    { key: "⌘ / Ctrl + ⏎", label: "Send what is in the composer" },
    { key: "T", label: "Switch theme" },
    { key: "?", label: "This list" },
    { key: "Esc", label: "Close whatever is open" },
  ];

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function attr(value) {
    return esc(value).replace(/\n/g, "&#10;");
  }

  function initials(name, email) {
    var source = String(name || email || "?").trim();
    var parts = source.split(/[\s@._-]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function shortAge(iso) {
    if (!iso) return "—";
    var minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 60) return minutes + "m";
    if (minutes < 60 * 24) return Math.round(minutes / 60) + "h";
    var days = Math.round(minutes / (60 * 24));
    return days < 14 ? days + "d" : Math.round(days / 7) + "w";
  }

  function ageMinutes(iso) {
    if (!iso) return 0;
    return Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  }

  function clockTime(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    var today = new Date();
    var sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString([], { day: "numeric", month: "short" }) +
      " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function longDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
  }

  // One amount, in the currency it was actually billed in.
  //
  // Everything here used to be PLN and the formatter said so in its parameter
  // name. Billing moved to USD and the old rows stayed PLN, so a single
  // hard-coded currency now mislabels one half of the ledger or the other.
  function amount(value, currency) {
    var n = Number(value || 0);
    var code = String(currency || "pln").toUpperCase();
    try {
      return n.toLocaleString(code === "PLN" ? "pl-PL" : "en-US", {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0
      });
    } catch (err) {
      // An unknown ISO code (a provider settling in something exotic) is worth
      // printing plainly rather than throwing the whole panel away.
      return n.toFixed(0) + " " + code;
    }
  }

  // Lifetime value arrives as one row per currency — see support_customer_context
  // in supabase/support-schema.sql. Summing them would invent a number, so they
  // are printed side by side; an empty ledger reads as a zero, not a blank.
  function money(ltv) {
    if (Array.isArray(ltv)) {
      if (!ltv.length) return amount(0, "usd");
      return ltv.map(function (row) { return amount(row.amount, row.currency); }).join(" + ");
    }
    // A number is a response from an older deployment of the schema, when the
    // only currency was PLN.
    return amount(ltv, "pln");
  }

  function priorityClass(priority) {
    if (priority === "urgent") return "chip chip-urgent";
    if (priority === "high") return "chip chip-high";
    return "chip";
  }

  function svg(paths, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;display:block">' +
      paths + "</svg>";
  }

  var ICON = {
    inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>'),
    list: svg('<path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>'),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'),
    chart: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"></path><path d="M7 16v-5"></path><path d="M12 16V8"></path><path d="M17 16v-3"></path>'),
    book: svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a2.5 2.5 0 0 1 0-5H20"></path>'),
    plus: svg('<path d="M5 12h14"></path><path d="M12 5v14"></path>', 22),
    search: svg('<path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle>', 16),
    clock: svg('<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>', 14),
    gear: svg('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle>', 18),
    keyboard: svg('<path d="M10 8h.01"></path><path d="M12 12h.01"></path><path d="M14 8h.01"></path><path d="M16 12h.01"></path><path d="M18 8h.01"></path><path d="M6 8h.01"></path><path d="M7 16h10"></path><path d="M8 12h.01"></path><rect width="20" height="16" x="2" y="4" rx="2"></rect>', 18),
    sun: svg('<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>', 18),
    moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>', 18),
    sort: svg('<path d="m3 16 4 4 4-4"></path><path d="M7 20V4"></path><path d="M11 4h10"></path><path d="M11 8h7"></path><path d="M11 12h4"></path>', 14),
    chevron: svg('<path d="m6 9 6 6 6-6"></path>', 16),
    shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path>', 16),
    info: svg('<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>', 20),
    spark: svg('<path d="M9.5 3 11 7.5 15.5 9 11 10.5 9.5 15 8 10.5 3.5 9 8 7.5z"></path><path d="M17.5 13 18.4 15.6 21 16.5 18.4 17.4 17.5 20 16.6 17.4 14 16.5 16.6 15.6z"></path>', 16),
    thumbUp: svg('<path d="M7 10v11"></path><path d="M14.5 3 12 10h6.6a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7V10l3.5-7a2 2 0 0 1 4 0z"></path>', 15),
    thumbDown: svg('<path d="M17 14V3"></path><path d="M9.5 21 12 14H5.4a2 2 0 0 1-2-2.4l1.3-6a2 2 0 0 1 2-1.6H17v11l-3.5 7a2 2 0 0 1-4 0z"></path>', 15),
    phone: svg('<rect width="14" height="20" x="5" y="2" rx="2"></rect><path d="M12 18h.01"></path><path d="M9 6h6"></path>', 16),
  };

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || "GET",
      headers: { "x-plately-panel": "1" },
      credentials: "same-origin",
      cache: "no-store",
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || "Request failed (" + res.status + ")");
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(message, bad) {
    var node = document.querySelector(".toast");
    if (node) node.remove();
    node = document.createElement("div");
    node.className = "toast" + (bad ? " bad" : "");
    node.textContent = message;
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); }, bad ? 6000 : 3200);
  }

  // -------------------------------------------------------------------------
  // Turnstile
  // -------------------------------------------------------------------------

  var turnstileLoading = null;

  function turnstileReady() {
    return Boolean(window.turnstile && typeof window.turnstile.render === "function");
  }

  /**
   * Loads Cloudflare's widget script the way Cloudflare documents it.
   *
   * With render=explicit the API object is NOT guaranteed to be complete when
   * the script tag's own onload fires: window.turnstile can already exist as a
   * bare object while render() is still being attached. Waiting on the tag was
   * the bug behind "the script loaded but installed no widget API" — nothing
   * was replacing anything, we were simply asking too early.
   *
   * The documented signal is the ?onload=<global> callback, so that is what we
   * wait for. A short poll after the tag loads covers the reverse ordering,
   * and a hard timeout covers a request that never returns at all.
   */
  function loadTurnstile() {
    if (turnstileReady()) return Promise.resolve();
    if (turnstileLoading) return turnstileLoading;

    turnstileLoading = new Promise(function (resolve, reject) {
      var CALLBACK = "__platelyTurnstileReady";
      var settled = false;
      var pollTimer = null;

      var finish = function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearInterval(pollTimer);
        // The global stays. Deleting it made Cloudflare log "unable to find
        // onload callback" whenever a second copy of the script ran, and the
        // `settled` guard already makes a late call a no-op.
        // Let a later attempt start over rather than replaying this failure
        // forever from the cached promise.
        if (err) {
          turnstileLoading = null;
          reject(err);
        } else {
          resolve();
        }
      };

      var hardTimer = setTimeout(function () {
        finish(new Error("challenges.cloudflare.com did not answer within 12 seconds"));
      }, 12000);

      window[CALLBACK] = function () { finish(turnstileReady() ? null : new Error("Turnstile reported ready without a render function")); };

      // One tag only. A second copy makes Cloudflare warn about being imported
      // twice and buys nothing: the API is already global once it lands.
      var existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
      if (existing) {
        if (turnstileReady()) return finish(null);
        pollTimer = setInterval(function () {
          if (turnstileReady()) finish(null);
        }, 50);
        return;
      }

      var script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=" + CALLBACK;
      script.async = true;
      script.defer = true;
      script.onload = function () {
        if (turnstileReady()) return finish(null);
        // The callback is the real signal; this only catches the case where it
        // has already run or will never come.
        pollTimer = setInterval(function () {
          if (turnstileReady()) finish(null);
        }, 50);
      };
      script.onerror = function () {
        finish(new Error("the browser refused the request to challenges.cloudflare.com — usually an ad blocker, a privacy extension or a network filter"));
      };
      document.head.appendChild(script);
    });

    return turnstileLoading;
  }

  // Turnstile's own failure codes. Every one of these is a configuration
  // problem with a different fix, and the widget renders them as a bare number
  // in a box nobody can read.
  var TURNSTILE_CODES = {
    "110200": "this hostname is not on the widget's list in Cloudflare — add plately.eu and www.plately.eu to it",
    "110100": "that site key does not exist",
    "110110": "that site key belongs to a different widget",
    "110500": "this browser is not supported by the challenge",
    "300030": "the challenge could not run — usually an extension or a blocked script",
  };

  // The container is deliberately NOT id="turnstile".
  //
  // A browser publishes every element id as a property of window, so a div with
  // that id makes window.turnstile a DIV. Cloudflare's api.js opens with a
  // "have I already been loaded?" check against exactly that global, finds the
  // element, logs "Turnstile already has been loaded" and returns without
  // installing render() — which then looks precisely like an ad blocker eating
  // the script. It cost three wrong diagnoses; the id stays as it is.
  function turnstileNote(message) {
    var note = document.getElementById("ts-note");
    if (note) note.textContent = message || "";
  }

  function mountTurnstile() {
    var host = document.getElementById("ts-widget");
    if (!host || !S.turnstile.siteKey) return;
    loadTurnstile().then(function () {
      if (!document.getElementById("ts-widget")) return;
      // render() throws on a bad site key or a container that already holds a
      // widget. Catching it here rather than letting it fall into the promise
      // chain is what keeps "could not download" and "could not start" apart.
      try {
        renderWidget(host);
      } catch (err) {
        S.turnstile.token = null;
        turnstileNote("Bot check could not start: " + (err && err.message ? err.message : err));
      }
    }).catch(function (err) {
      // The widget sits beside Google and the PIN; if Cloudflare is
      // unreachable those two still stand, so the desk stays usable rather
      // than dead.
      S.turnstile.token = null;
      turnstileNote("Bot check unavailable — " + (err && err.message ? err.message : err));
    });
  }

  function renderWidget(host) {
    S.turnstile.widget = window.turnstile.render(host, {
      sitekey: S.turnstile.siteKey,
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      callback: function (token) {
        S.turnstile.token = token;
        turnstileNote("");
      },
      "expired-callback": function () {
        S.turnstile.token = null;
        turnstileNote("The check expired. Reload the page.");
      },
      "error-callback": function (code) {
        // Leave the button alone: the server decides, and it now says why.
        // Blocking here as well would hide the reason behind a dead control.
        S.turnstile.token = null;
        var known = TURNSTILE_CODES[String(code)];
        turnstileNote("Bot check could not run" + (code ? " (" + code + ")" : "") + (known ? " — " + known : "."));
      },
    });
  }

  function resetTurnstile() {
    S.turnstile.token = null;
    if (window.turnstile && S.turnstile.widget !== null) {
      try { window.turnstile.reset(S.turnstile.widget); } catch (err) { /* widget already gone */ }
    }
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  function boot() {
    api("/api/staff/session").then(function (data) {
      S.auth = data;
      S.turnstile.siteKey = data.turnstileSiteKey || null;
      if (data.state === "signed_in") {
        S.staff = data.staff;
        S.perms = data.permissions || {};
        S.mailConfigured = data.mailConfigured !== false;
        return loadDesk();
      }
      S.phase = data.state;
      render();
    }).catch(function (err) {
      S.phase = "signed_out";
      S.error = err.message;
      render();
    });
  }

  function loadDesk() {
    return api("/api/support/bootstrap").then(function (data) {
      S.counts = data.counts || {};
      S.macros = data.macros || [];
      S.team = data.team || [];
      S.settings = data.settings || null;
      S.tags = data.tags || [];
      S.statuses = data.statuses || [];
      S.priorities = data.priorities || [];
      S.mailConfigured = data.mailConfigured !== false;
      S.aiConfigured = data.aiConfigured === true;
      S.phase = "ready";
      render();
      return refreshTickets(true);
    });
  }

  // -------------------------------------------------------------------------
  // data loading
  // -------------------------------------------------------------------------

  function refreshTickets(selectFirst) {
    S.listBusy = true;
    var query = "/api/support/tickets?view=" + encodeURIComponent(S.view) +
      "&sort=" + encodeURIComponent(S.sort) +
      (S.search ? "&search=" + encodeURIComponent(S.search) : "");
    return api(query).then(function (data) {
      S.tickets = data.tickets || [];
      S.counts = data.counts || S.counts;
      S.listBusy = false;
      var stillThere = S.tickets.some(function (t) { return t.id === S.selectedId; });
      if (selectFirst && !stillThere && S.tickets.length) {
        return openTicket(S.tickets[0].id);
      }
      render();
    }).catch(function (err) {
      S.listBusy = false;
      toast(err.message, true);
      render();
    });
  }

  function openTicket(id) {
    S.selectedId = id;
    S.detail = null;
    render();
    return api("/api/support/ticket?id=" + encodeURIComponent(id)).then(function (data) {
      if (S.selectedId !== id) return;
      S.detail = data;
      render();
      scrollThreadToEnd();
    }).catch(function (err) { toast(err.message, true); });
  }

  function scrollThreadToEnd() {
    var body = document.querySelector(".thread-body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  function loadScreen(screen) {
    S.screen = screen;
    render();
    if (screen === "customers" && !S.customers) {
      api("/api/support/customers").then(function (d) { S.customers = d.customers || []; render(); });
    }
    if (screen === "reports" && !S.reports) {
      api("/api/support/reports?days=14").then(function (d) { S.reports = d; render(); });
    }
    if (screen === "kb" && !S.articles) {
      api("/api/support/kb").then(function (d) { S.articles = d.articles || []; render(); });
    }
    if (screen === "settings") {
      if (!S.staffList) {
        api("/api/staff/list").then(function (d) { S.staffList = d.staff || []; render(); });
      }
      if (S.perms.maintenance && S.maintenance === null) {
        api("/api/support/maintenance").then(function (d) { S.maintenance = d.mode; render(); });
      }
    }
    if (screen === "tickets") {
      api("/api/support/tickets?view=all&sort=newest&limit=200").then(function (d) {
        S.allTickets = d.tickets || [];
        render();
      });
    }
  }

  // -------------------------------------------------------------------------
  // render — top level
  // -------------------------------------------------------------------------

  function render() {
    root.className = "";
    if (S.phase === "loading") {
      root.className = "loading";
      root.innerHTML = '<span class="spinner"></span> Loading the desk…';
      return;
    }
    if (S.phase === "signed_out") return renderSignIn();
    if (S.phase === "pin_required" || S.phase === "pin_setup") return renderPin();
    if (S.phase === "totp_required" || S.phase === "totp_setup") return renderTotp();
    renderApp();
  }

  function heroSide() {
    return '' +
      '<div class="auth-hero">' +
        '<img class="auth-mark" src="/logo.png" alt="Plately">' +
        '<div class="auth-copy">' +
          "<h1>Every customer e-mail, one shared inbox</h1>" +
          "<p>Ticket list and full conversation side by side, with the customer's history and their actual plan. No tab switching, no lost threads.</p>" +
        "</div>" +
      "</div>";
  }

  var AUTH_ERRORS = {
    not_staff: "That Google account is not on the support team. Ask an owner to add it first.",
    inactive: "That account has been deactivated.",
    account_mismatch: "This address is registered to a different Google account.",
    bad_state: "The sign-in link expired. Start again.",
    bad_nonce: "The sign-in link expired. Start again.",
    google_denied: "Google sign-in was cancelled.",
    google_exchange: "Google refused the sign-in. Try again.",
    google_token: "Google returned something we could not read.",
    google_audience: "This deployment's Google client id does not match.",
    google_issuer: "The token did not come from Google.",
    google_expired: "That sign-in took too long. Try again.",
    email_unverified: "That Google account has no verified e-mail address.",
    not_configured: "Google sign-in is not configured on this deployment yet.",
    no_email: "Google did not share an e-mail address.",
  };

  function renderSignIn() {
    var params = new URLSearchParams(location.search);
    var code = params.get("error");
    var message = code ? (AUTH_ERRORS[code] || "Sign-in failed (" + code + ").") : S.error;

    root.innerHTML =
      '<div class="auth">' +
        heroSide() +
        '<div class="auth-panel"><div class="auth-box">' +
          "<h2>Sign in to Plately Help Desk</h2>" +
          '<p class="lede">Please do not log in unless you are a Plately employee. Access is restricted to verified accounts only and is intended solely for providing customer support.</p>' +
          (S.auth.googleConfigured === false
            ? '<div class="auth-error">Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel.</div>'
            : "") +
          '<button type="button" class="google-btn" data-act="google">' +
            '<svg width="18" height="18" viewBox="0 0 48 48" style="flex:none;display:block"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"></path><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"></path><path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.6 39.6 16.3 44 24 44z"></path><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.6 5.6C39.9 37.4 44 31.4 44 24c0-1.3-.1-2.7-.4-3.5z"></path></svg>' +
            "Continue with Google" +
          "</button>" +
          (message ? '<div class="auth-error">' + esc(message) + "</div>" : "") +
          '<div class="auth-note">' + ICON.info +
            "<p><strong style=\"color:var(--m3-on-surface)\">Looking for help with Plately?</strong><br>" +
            "This page is not intended as customer support. If you need assistance, " +
            'please write to us at <a class="auth-link" href="/help">plately.eu/help</a>.</p>' +
          "</div>" +
        "</div></div>" +
      "</div>";
  }

  /**
   * The PIN: the last gate, and the first sight of the console.
   *
   * This step is deliberately staged differently from the two before it. Google
   * and the authenticator happen on the sign-in page; the PIN happens *here*,
   * over the desk itself, because it is the moment the door actually opens and
   * the screen should say so.
   *
   * What sits behind the modal is a SKELETON — grey bars in the real layout,
   * carrying no text, no names, no numbers. That is the point. Blur is a
   * decoration anyone can delete from the styles panel in two seconds, so it is
   * never what keeps anything private here: there is simply nothing underneath
   * to reveal. The server agrees — a pre-session authorises no endpoint at all,
   * so even a crafted request returns 401.
   */
  function renderPin() {
    var setup = S.phase === "pin_setup";
    var locked = S.auth.lockedUntil && new Date(S.auth.lockedUntil) > new Date();

    root.innerHTML =
      '<div class="locked-stage">' +
        '<div class="locked-shell" aria-hidden="true">' + skeletonConsole() + "</div>" +
        '<div class="lock-scrim">' +
          '<div class="lock-card" role="dialog" aria-modal="true" aria-label="Final step">' +
            '<div class="lock-badge">' + ICON.shield + "</div>" +
            '<p class="lock-kicker">One last step</p>' +
            "<h2>" + (setup ? "Choose your access PIN" : "Enter your PIN") + "</h2>" +
            '<p class="lock-lede">' + (setup
              ? "Four digits, asked for every time you sign in. This is the one thing that never leaves your head — it is what protects the console if a device is left open and unattended."
              : "Google and your authenticator both checked out. Your PIN opens the desk.") + "</p>" +
            '<div class="identity">' +
              (S.auth.avatarUrl
                ? '<img src="' + attr(S.auth.avatarUrl) + '" alt="">'
                : '<span class="avatar">' + esc(initials(S.auth.displayName, S.auth.email)) + "</span>") +
              '<span class="who"><b>' + esc(S.auth.displayName || S.auth.email) + "</b>" +
              "<span>" + esc(S.auth.email) + "</span></span>" +
            "</div>" +
            (setup ? '<p class="lock-sub">Choose four digits</p>' : "") +
            '<div class="pin-row" data-pin-group="a">' + pinBoxes("a") + "</div>" +
            (setup
              ? '<p class="lock-sub">Confirm the same four digits</p>' +
                '<div class="pin-row" data-pin-group="b">' + pinBoxes("b") + "</div>"
              : "") +
            (S.turnstile.siteKey
              ? '<div class="ts-slot" id="ts-widget"></div>' +
                '<div class="ts-note" id="ts-note"></div>'
              : "") +
            '<button type="button" class="btn btn-primary lock-submit" data-act="pin-submit">' +
              (setup ? "Set PIN and open the console" : "Open the console") +
            "</button>" +
            (locked ? '<div class="auth-error">Locked until ' + esc(clockTime(S.auth.lockedUntil)) + ".</div>" : "") +
            (S.error ? '<div class="auth-error">' + esc(S.error) + "</div>" : "") +
            (S.notice ? '<div class="auth-ok">' + esc(S.notice) + "</div>" : "") +
            '<div class="lock-foot">' +
              (setup ? "" : "<span>Five incorrect attempts lock the account for fifteen minutes.</span>") +
              '<button type="button" data-act="signout">Sign in as someone else</button>' +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";

    mountTurnstile();
    var first = root.querySelector('[data-pin="a0"]');
    if (first) first.focus();
  }

  /**
   * How far through the three gates the person is.
   *
   * Google is behind them by the time this is drawn at all, so it always shows
   * as done. The point is the middle state: "you are recognised, but you are
   * not in yet", which is otherwise the confusing part of a sign-in that asks
   * for three things.
   */
  function authSteps(current) {
    var steps = [
      { key: "google", label: "Google" },
      { key: "totp", label: "Authenticator" },
      { key: "pin", label: "PIN" },
    ];
    var at = steps.findIndex(function (s) { return s.key === current; });
    return '<ol class="auth-steps">' + steps.map(function (s, i) {
      var state = i < at ? "done" : i === at ? "now" : "";
      return '<li class="' + state + '"><i>' + (i < at ? "✓" : i + 1) + "</i>" + esc(s.label) + "</li>";
    }).join("") + "</ol>";
  }

  /** Avatar, name and address — the proof that Google is already behind us. */
  function halfSignedIn() {
    return '<div class="half-in">' +
      '<div class="identity">' +
        (S.auth.avatarUrl
          ? '<img src="' + attr(S.auth.avatarUrl) + '" alt="">'
          : '<span class="avatar">' + esc(initials(S.auth.displayName, S.auth.email)) + "</span>") +
        '<span class="who"><b>' + esc(S.auth.displayName || S.auth.email) + "</b>" +
        "<span>" + esc(S.auth.email) + "</span></span>" +
        '<span class="half-badge">Half signed in</span>' +
      "</div>" +
      '<p class="half-note">Google has confirmed who you are. Two short steps left before the console opens.</p>' +
    "</div>";
  }

  /**
   * The authenticator step — still the sign-in page, not the console.
   *
   * Deliberately the same layout as the Google button it replaces: the person
   * has not gone anywhere, they have simply been handed the next thing to do.
   * The console only ever appears behind the final step, so "am I in yet?"
   * always has an obvious answer.
   *
   * Two shapes, one screen. On a first run it shows a QR code and asks for a
   * code back, which is the only way to prove the phone actually holds the
   * secret before it is trusted. Afterwards it is six boxes and nothing else.
   *
   * The QR is inline SVG drawn by our own server, not an <img> pointing at an
   * image service: the string encoded in it *is* a live second factor, and it
   * has no business travelling to anyone else.
   */
  function renderTotp() {
    var setup = S.phase === "totp_setup";
    var locked = S.auth.lockedUntil && new Date(S.auth.lockedUntil) > new Date();

    var enrolBlock = "";
    if (setup) {
      enrolBlock = S.enrol
        ? '<div class="enrol">' +
            '<div class="enrol-qr">' + S.enrol.qr + "</div>" +
            '<div class="enrol-side">' +
              '<ol class="enrol-steps">' +
                "<li>Open Google Authenticator, Aegis, 1Password, Bitwarden — any of them.</li>" +
                "<li>Scan this code.</li>" +
                "<li>Type the six digits it shows below.</li>" +
              "</ol>" +
              (S.showSecret
                ? '<div class="enrol-secret"><span class="lbl">Or enter this key by hand</span>' +
                  '<code>' + esc(S.enrol.secret) + "</code></div>"
                : '<button type="button" class="linkish" data-act="show-secret">Can’t scan? Show the key instead</button>') +
              '<button type="button" class="linkish" data-act="enrol-again">Start over with a new code</button>' +
            "</div>" +
          "</div>"
        : '<div class="enrol enrol-loading"><span class="spinner"></span></div>';
    }

    root.innerHTML =
      '<div class="auth">' +
        heroSide() +
        '<div class="auth-panel"><div class="auth-box ' + (setup ? "auth-box-wide" : "") + '">' +
          halfSignedIn() +
          authSteps("totp") +
          "<h2>" + (setup ? "Link your authenticator app" : "Authenticator code") + "</h2>" +
          '<p class="lede">' + (setup
            ? "From now on the console asks for a code from this app every time you sign in — it is what keeps the desk shut if your Google session is ever taken."
            : "Enter the code your authenticator app is showing right now.") + "</p>" +
          enrolBlock +
          '<label class="field-label" for="code-a0">' +
            (setup ? "The six digits from the app" : "Six-digit code") + "</label>" +
          '<div class="pin-row pin-row-6" data-pin-group="a">' + codeBoxes("a") + "</div>" +
          (S.turnstile.siteKey
            ? '<div class="ts-slot" id="ts-widget"></div>' +
              '<div class="ts-note" id="ts-note"></div>'
            : "") +
          '<button type="button" class="btn btn-primary auth-submit" data-act="totp-submit">Continue</button>' +
          (locked ? '<div class="auth-error">Locked until ' + esc(clockTime(S.auth.lockedUntil)) + ".</div>" : "") +
          (S.error ? '<div class="auth-error">' + esc(S.error) + "</div>" : "") +
          '<div class="auth-foot">' +
            "<span>" + (setup
              ? "Codes change every 30 seconds. If one is refused, wait for the next."
              : "Lost the phone? An owner can unlink it from Settings → Team and roles.") + "</span>" +
            '<button type="button" data-act="signout">Sign in as someone else</button>' +
          "</div>" +
        "</div></div>" +
      "</div>";

    mountTurnstile();
    if (setup && !S.enrol && !S.enrolBusy) return startEnrolment();
    var first = root.querySelector('[data-pin="a0"]');
    if (first) first.focus();
  }

  function startEnrolment() {
    S.enrolBusy = true;
    api("/api/staff/totp-enrol", { method: "POST", body: {} })
      .then(function (data) {
        S.enrol = data;
        S.enrolBusy = false;
        render();
      })
      .catch(function (err) {
        S.enrolBusy = false;
        S.error = err.message;
        render();
      });
  }

  /** Empty scaffolding in the real layout. Deliberately holds no content. */
  function skeletonConsole() {
    var bar = function (w, h) {
      return '<span class="sk" style="width:' + w + ';height:' + (h || 10) + 'px"></span>';
    };
    var row = "";
    for (var i = 0; i < 7; i++) {
      row += '<div class="sk-row">' +
        '<span class="sk sk-dot"></span>' +
        '<div class="sk-lines">' + bar("42%") + bar("78%") + bar("30%", 8) + "</div>" +
      "</div>";
    }
    var card = function (lines) {
      var body = "";
      for (var j = 0; j < lines; j++) body += bar(60 + ((j * 13) % 35) + "%");
      return '<div class="sk-card">' + bar("40%", 8) + '<div class="sk-lines">' + body + "</div></div>";
    };

    return '<div class="shell">' +
      '<nav class="nav">' +
        '<div class="nav-brand"><img class="mark" src="/logo.png" alt=""><div>' +
          "<b>Plately</b><span>SUPPORT</span></div></div>" +
        '<div class="sk sk-pill"></div>' +
        '<div class="sk-lines" style="gap:14px;margin-top:16px">' +
          bar("80%", 14) + bar("65%", 14) + bar("72%", 14) + bar("58%", 14) + bar("68%", 14) +
        "</div>" +
      "</nav>" +
      '<div class="main">' +
        '<header class="topbar">' + bar("180px", 16) + '<div class="sk sk-search"></div>' + "</header>" +
        '<div class="screen screen-inbox">' +
          '<section class="list"><div class="list-head">' + bar("120px", 14) + "</div>" +
            '<div class="list-scroll">' + row + "</div></section>" +
          '<section class="thread"><div class="thread-head">' + bar("60%", 18) + bar("35%", 10) + "</div>" +
            '<div class="thread-body">' + card(4) + card(3) + card(5) + "</div></section>" +
          '<aside class="aside">' + card(4) + card(3) + "</aside>" +
        "</div>" +
      "</div>" +
    "</div>";
  }

  /**
   * A row of single-digit boxes.
   *
   * No maxlength: a pasted or fast-typed "4821" must arrive intact so the
   * input handler can spread it across the row. Capping it at one character
   * here would silently throw the other digits away.
   *
   * The PIN is masked because it is a stored secret and shoulder-surfing it is
   * worth something. An authenticator code is not: it is gone in thirty
   * seconds, and being able to see what you typed is worth more than hiding a
   * number the attacker would have to use within the half-minute.
   */
  function digitBoxes(group, count, masked) {
    var out = "";
    for (var i = 0; i < count; i++) {
      out += '<input class="pin-box" type="' + (masked ? "password" : "text") +
        '" inputmode="numeric" autocomplete="' + (masked ? "off" : "one-time-code") +
        '" aria-label="Digit ' + (i + 1) + ' of ' + count + '" data-pin="' + group + i + '">';
    }
    return out;
  }

  function pinBoxes(group) { return digitBoxes(group, 4, true); }
  function codeBoxes(group) { return digitBoxes(group, 6, false); }

  function readDigits(group, count) {
    var value = "";
    for (var i = 0; i < count; i++) {
      var box = root.querySelector('[data-pin="' + group + i + '"]');
      value += box && box.value ? box.value : "";
    }
    return value;
  }

  function readPin(group) { return readDigits(group, 4); }

  function clearPins() {
    Array.prototype.forEach.call(root.querySelectorAll(".pin-box"), function (box) {
      box.value = "";
      box.classList.remove("filled");
    });
    var first = root.querySelector('[data-pin="a0"]');
    if (first) first.focus();
  }

  // -------------------------------------------------------------------------
  // render — the app
  // -------------------------------------------------------------------------

  function renderApp() {
    var title = SCREEN_TITLES[S.screen] || SCREEN_TITLES.inbox;
    root.innerHTML =
      '<div class="shell">' +
        renderNav() +
        '<div class="main">' +
          renderTopbar(title) +
          renderScreen() +
        "</div>" +
      "</div>";
    if (S.screen === "inbox") scrollThreadToEnd();
  }

  function renderNav() {
    var open = S.counts.open || 0;
    var subViews = S.inboxOpen ? '<div class="nav-sub">' + VIEWS.map(function (v) {
      return '<button type="button" data-act="view" data-view="' + v.key + '" class="' + (S.view === v.key && S.screen === "inbox" ? "active" : "") + '">' +
        "<span>" + esc(v.label) + '</span><span class="count">' + (S.counts[v.count] || 0) + "</span></button>";
    }).join("") + "</div>" : "";

    return '<nav class="nav">' +
      '<div class="nav-brand"><img class="mark" src="/logo.png" alt="Plately"><div><b>Plately</b><span>SUPPORT</span></div></div>' +
      (S.perms.reply
        ? '<button type="button" class="nav-new" data-act="compose">' + ICON.plus + "<span>New ticket</span></button>"
        : "") +
      '<button type="button" class="nav-item ' + (S.screen === "inbox" ? "active" : "") + '" data-act="nav" data-screen="inbox">' +
        ICON.inbox + "<span>Inbox</span>" +
        '<span class="badge">' + open + "</span>" +
      "</button>" +
      subViews +
      '<button type="button" class="nav-item ' + (S.screen === "tickets" ? "active" : "") + '" data-act="nav" data-screen="tickets">' +
        ICON.list + "<span>All tickets</span></button>" +
      '<button type="button" class="nav-item ' + (S.screen === "customers" ? "active" : "") + '" data-act="nav" data-screen="customers">' +
        ICON.users + "<span>Customers</span></button>" +
      '<button type="button" class="nav-item ' + (S.screen === "reports" ? "active" : "") + '" data-act="nav" data-screen="reports">' +
        ICON.chart + "<span>Reports</span></button>" +
      '<button type="button" class="nav-item ' + (S.screen === "kb" ? "active" : "") + '" data-act="nav" data-screen="kb">' +
        ICON.book + "<span>Knowledge base</span></button>" +
      '<div class="nav-foot">' +
        '<div class="nav-queue">' +
          '<div class="h">' + ICON.clock + " Your queue</div>" +
          "<p>" + (S.counts.mine || 0) + " assigned to you · " + (S.counts.overdue || 0) + " waiting over a day.</p>" +
          '<button type="button" class="btn btn-primary btn-sm" style="width:100%" data-act="nav" data-screen="reports">See reports</button>' +
        "</div>" +
        '<button type="button" class="nav-profile ' + (S.screen === "settings" ? "active" : "") + '" data-act="nav" data-screen="settings">' +
          (S.staff.avatarUrl
            ? '<img class="avatar" src="' + attr(S.staff.avatarUrl) + '" alt="" style="width:34px;height:34px">'
            : '<span class="avatar">' + esc(initials(S.staff.displayName, S.staff.email)) + "</span>") +
          '<span class="who"><b>' + esc(S.staff.displayName) + "</b><span>" + esc(roleLabel(S.staff)) + "</span></span>" +
          ICON.gear +
        "</button>" +
      "</div>" +
    "</nav>";
  }

  function roleLabel(staff) {
    if (staff.role === "agent") return "Support agent · Tier " + staff.tier;
    return staff.role.charAt(0).toUpperCase() + staff.role.slice(1);
  }

  function renderTopbar(title) {
    var dark = document.documentElement.dataset.theme !== "light";
    return '<header class="topbar">' +
      '<div class="titles"><h1>' + esc(title[0]) + "</h1><p>" + esc(title[1]) + "</p></div>" +
      '<div class="searchwrap">' + ICON.search +
        '<input type="text" id="search" placeholder="Search tickets, customers or article titles" value="' + attr(S.search) + '">' +
        "<kbd>/</kbd>" +
      "</div>" +
      '<div class="right">' +
        '<span class="presence"><i></i>' + esc(S.team.length) + " agent" + (S.team.length === 1 ? "" : "s") + " on the team</span>" +
        '<button type="button" class="btn btn-icon" data-act="theme" title="Theme (T)">' + (dark ? ICON.sun : ICON.moon) + "</button>" +
        '<button type="button" class="btn btn-icon" data-act="shortcuts" title="Keyboard shortcuts (?)">' + ICON.keyboard + "</button>" +
      "</div>" +
    "</header>";
  }

  function renderScreen() {
    switch (S.screen) {
      case "inbox": return renderInbox();
      case "tickets": return renderAllTickets();
      case "customers": return renderCustomers();
      case "reports": return renderReports();
      case "kb": return renderKb();
      case "settings": return renderSettings();
      default: return "";
    }
  }

  // --- inbox ----------------------------------------------------------------

  function currentViewLabel() {
    var found = VIEWS.filter(function (v) { return v.key === S.view; })[0];
    return found ? found.label : "Inbox";
  }

  function groupTickets(tickets) {
    if (S.sort !== "age") {
      return [{ label: currentViewLabel(), hint: S.sort === "newest" ? "newest first" : "by priority", accent: "var(--m3-primary)", rows: tickets }];
    }
    var groups = [
      { label: "Waiting over a day", hint: "answer these first", accent: "var(--m3-error)", rows: [] },
      { label: "Today", hint: "still inside the promise", accent: "var(--m3-tertiary)", rows: [] },
      { label: "Just in", hint: "under four hours", accent: "var(--m3-primary)", rows: [] },
    ];
    tickets.forEach(function (t) {
      var minutes = ageMinutes(t.last_customer_message_at || t.created_at);
      if (minutes > 60 * 24) groups[0].rows.push(t);
      else if (minutes > 60 * 4) groups[1].rows.push(t);
      else groups[2].rows.push(t);
    });
    return groups.filter(function (g) { return g.rows.length; });
  }

  function renderInbox() {
    var groups = groupTickets(S.tickets);
    var rows = groups.map(function (g) {
      return '<div><div class="group-head"><i style="background:' + g.accent + '"></i>' +
        "<b>" + esc(g.label) + "</b><span>" + esc(g.hint) + '</span><span class="n">' + g.rows.length + "</span></div>" +
        g.rows.map(ticketRow).join("") + "</div>";
    }).join("");

    var list =
      '<section class="list">' +
        '<div class="list-head">' +
          '<div class="row"><h2>' + esc(currentViewLabel()) + "</h2>" +
            '<span class="of">' + S.tickets.length + " of " + (S.counts.all || S.tickets.length) + "</span>" +
            '<button type="button" class="btn btn-sm" style="margin-left:auto" data-act="sort">' + ICON.sort +
              (S.sort === "age" ? "Oldest waiting" : S.sort === "newest" ? "Newest first" : "By priority") +
            "</button>" +
          "</div>" +
          '<div class="filters">' +
            VIEWS.slice(0, 5).map(function (v) {
              return '<button type="button" class="filter ' + (S.view === v.key ? "on" : "") + '" data-act="view" data-view="' + v.key + '">' +
                "<span>" + esc(v.label) + "</span><strong>" + (S.counts[v.count] || 0) + "</strong></button>";
            }).join("") +
            (S.view !== "all_open" || S.search
              ? '<button type="button" class="filter-clear" data-act="clear-filters">Clear</button>'
              : "") +
          "</div>" +
        "</div>" +
        '<div class="list-scroll">' +
          (S.listBusy && !S.tickets.length
            ? '<div class="empty"><span class="spinner"></span></div>'
            : S.tickets.length
              ? rows
              : '<div class="empty"><strong>Nothing here</strong><p>' +
                (S.search ? "No ticket matches that search." : "This view is empty — which on a support desk is the good outcome.") +
                "</p></div>") +
        "</div>" +
      "</section>";

    return '<div class="screen screen-inbox">' + list + renderThread() + renderAside() + "</div>";
  }

  function ticketRow(t) {
    var minutes = ageMinutes(t.last_customer_message_at || t.created_at);
    var ageColor = minutes > 60 * 24 ? "var(--m3-error)" : minutes > 60 * 4 ? "var(--m3-on-surface)" : "var(--m3-on-surface-variant)";
    return '<button type="button" class="trow ' + (t.id === S.selectedId ? "sel" : "") + '" data-act="open" data-id="' + attr(t.id) + '">' +
      '<span class="age"><b style="color:' + ageColor + '">' + esc(shortAge(t.last_customer_message_at || t.created_at)) + "</b>" +
        '<span class="' + priorityClass(t.priority) + '">' + esc(t.priority) + "</span></span>" +
      '<span class="body">' +
        '<span class="line1">' +
          '<span class="who">' + esc(t.customer_name || t.customer_email) + "</span>" +
          '<span class="ref">SUP-' + esc(t.number) + "</span>" +
          '<span class="asg">' + esc(t.assignee_name || (t.assignee_id ? t.assignee_email : "Unassigned")) + "</span>" +
        "</span>" +
        '<span class="subj">' + esc(t.subject) + "</span>" +
        '<span class="meta">' +
          (t.tag ? '<span class="tag-mini">' + esc(t.tag) + "</span>" : "") +
          '<span class="tag-mini">' + esc(t.status) + "</span>" +
          '<span class="msgs">' + esc(t.message_count) + " msg</span>" +
        "</span>" +
      "</span>" +
    "</button>";
  }

  function renderThread() {
    if (!S.selectedId) {
      return '<section class="thread"><div class="empty" style="height:100%">' +
        "<strong>Pick a ticket</strong><p>The list on the left is ordered by how long someone has been waiting. The oldest is at the top.</p></div></section>";
    }
    if (!S.detail) {
      return '<section class="thread"><div class="empty" style="height:100%"><span class="spinner"></span></div></section>';
    }

    var t = S.detail.ticket;
    var canWrite = S.perms.reply || S.perms.note;
    var messages = (S.detail.messages || []).map(messageBubble).join("");

    return '<section class="thread">' +
      '<div class="thread-head">' +
        '<div class="top">' +
          '<div class="t-title"><h2>' + esc(t.subject) + "</h2>" +
            '<p class="sub">SUP-' + esc(t.number) + " · " + esc(t.customer_email) + " · opened " + esc(shortAge(t.created_at)) + " ago</p></div>" +
          '<div class="acts">' +
            (S.perms.assign_self || S.perms.assign_other
              ? '<button type="button" class="btn" data-act="menu-assign">Assign</button>' : "") +
            (S.perms.escalate ? '<button type="button" class="btn" data-act="escalate">Escalate</button>' : "") +
            (S.perms.solve
              ? '<button type="button" class="btn btn-primary" data-act="status" data-status="' +
                (t.status === "solved" || t.status === "closed" ? "open" : "solved") + '">' +
                (t.status === "solved" || t.status === "closed" ? "Reopen" : "Mark solved") + "</button>"
              : "") +
            ((S.perms.spam || S.perms["delete"])
              ? '<button type="button" class="btn btn-icon" data-act="menu-more" title="More">…</button>'
              : "") +
          "</div>" +
        "</div>" +
        '<div class="tags">' +
          '<span class="' + priorityClass(t.priority) + '" data-act="menu-priority" style="cursor:pointer">' + esc(t.priority) + " priority</span>" +
          '<span class="chip chip-plain" data-act="menu-tag" style="cursor:pointer">' + esc(t.tag || "+ tag") + "</span>" +
          '<span class="chip chip-plain">' + esc(t.channel) + "</span>" +
          '<span class="chip chip-plain">' + esc(t.status) + "</span>" +
          '<span class="who">Assigned to ' + esc(t.assignee_name || t.assignee_email || "nobody") + "</span>" +
        "</div>" +
      "</div>" +
      '<div class="thread-body">' + (messages || '<div class="empty"><p>No messages on this ticket yet.</p></div>') + "</div>" +
      (canWrite ? composer(t) : "") +
    "</section>";
  }

  function messageBubble(m) {
    var cls = m.kind === "reply" ? "msg msg-out" : m.kind === "note" ? "msg msg-note" : m.kind === "system" ? "msg msg-system" : "msg msg-in";
    var kind = m.kind === "reply" ? "Reply sent" : m.kind === "note" ? "Internal note" : m.kind === "system" ? "Activity" : "Customer";
    if (m.kind === "system") {
      return '<article class="' + cls + '"><p>' + esc(m.body) + " · " + esc(clockTime(m.created_at)) + "</p></article>";
    }
    return '<article class="' + cls + '">' +
      '<div class="h">' +
        '<span class="avatar">' + esc(initials(m.author_name, m.author_email)) + "</span>" +
        "<b>" + esc(m.author_name || m.author_email) + "</b>" +
        '<span class="kind">' + esc(kind) + "</span>" +
        "<time>" + esc(clockTime(m.created_at)) + "</time>" +
      "</div>" +
      "<p>" + esc(m.body) + "</p>" +
      ((m.attachments && m.attachments.length)
        ? '<div class="meta" style="font-size:12px;opacity:.8">' +
          m.attachments.map(function (a) { return esc(a.filename); }).join(" · ") + "</div>"
        : "") +
    "</article>";
  }

  /**
   * The AI strip above the composer.
   *
   * Three states, and the middle one is the important one. Before: an offer.
   * After: a banner saying plainly that a machine wrote what is now in the box
   * and a person is accountable for sending it. The thumbs sit here rather than
   * after sending, because this is the moment the agent has actually just
   * judged the text.
   *
   * Notes never get this. An internal note is one colleague talking to another
   * and there is nothing for a model to do in it.
   */
  function aiBar(t, noteMode) {
    if (noteMode || !S.perms.reply) return "";
    var draft = S.aiDrafts[t.id];

    if (!draft) {
      if (!S.aiConfigured) return "";
      return '<div class="ai-bar">' +
        '<button type="button" class="ai-btn" data-act="ai-draft" ' + (S.aiBusy ? "disabled" : "") + ">" +
          (S.aiBusy ? '<span class="spinner"></span>' : ICON.spark) +
          "<span>" + (S.aiBusy ? "Reading the knowledge base…" : "Use AI") + "</span>" +
        "</button>" +
        '<span class="ai-hint">Drafts a reply from published articles. You read it before anything is sent.</span>' +
      "</div>";
    }

    return '<div class="ai-bar ai-bar-done">' +
      '<span class="ai-tag">' + ICON.spark + "AI draft</span>" +
      '<span class="ai-hint">' +
        (draft.articlesUsed
          ? "From " + esc(draft.articlesUsed) + " knowledge-base article" + (draft.articlesUsed === 1 ? "" : "s") + " — check it before sending."
          : "No published articles to work from, so check this especially carefully.") +
      "</span>" +
      '<span class="ai-rate">' +
        '<button type="button" class="ai-thumb ' + (draft.rating === 1 ? "on up" : "") + '" data-act="ai-rate" data-rating="1" title="Good draft — show answers like this to the model next time">' + ICON.thumbUp + "</button>" +
        '<button type="button" class="ai-thumb ' + (draft.rating === -1 ? "on down" : "") + '" data-act="ai-rate" data-rating="-1" title="Bad draft — tell the model not to answer like this again">' + ICON.thumbDown + "</button>" +
        '<button type="button" class="ai-thumb" data-act="ai-discard" title="Discard the draft">✕</button>' +
      "</span>" +
    "</div>";
  }

  function composer(t) {
    var draft = S.drafts[t.id] || "";
    var noteMode = S.composerKind === "note";
    var canSend = noteMode ? S.perms.note : S.perms.reply;
    return '<div class="composer ' + (noteMode ? "note-mode" : "") + '">' +
      '<div class="tabs">' +
        (S.perms.reply ? '<button type="button" class="tab ' + (!noteMode ? "on" : "") + '" data-act="kind" data-kind="reply">Public reply</button>' : "") +
        (S.perms.note ? '<button type="button" class="tab note ' + (noteMode ? "on" : "") + '" data-act="kind" data-kind="note">Internal note</button>' : "") +
        '<span class="hint">' + (noteMode
          ? "Only the team sees this"
          : (S.mailConfigured ? "Goes to " + esc(t.customer_email) : "No mail provider configured — replies cannot be sent")) + "</span>" +
      "</div>" +
      aiBar(t, noteMode) +
      '<textarea id="composer" placeholder="' + (noteMode ? "Leave a note for whoever picks this up next…" : "Write the reply…") + '">' + esc(draft) + "</textarea>" +
      '<div class="foot">' +
        S.macros.slice(0, 4).map(function (m) {
          return '<button type="button" class="macro" data-act="macro" data-id="' + attr(m.id) + '">' + esc(m.label) + "</button>";
        }).join("") +
        '<div class="send">' +
          '<span class="mono">⌘ + ⏎</span>' +
          (!noteMode && S.perms.solve
            ? '<button type="button" class="btn" data-act="send" data-solve="1" ' + (canSend ? "" : "disabled") + ">Send &amp; solve</button>"
            : "") +
          '<button type="button" class="btn btn-primary" data-act="send" ' + (canSend ? "" : "disabled") + ">" +
            (noteMode ? "Save note" : "Send reply") + "</button>" +
        "</div>" +
      "</div>" +
    "</div>";
  }

  function renderAside() {
    if (!S.detail || !S.detail.context) return "";
    var ctx = S.detail.context;
    var customer = ctx.customer || {};
    var orders = ctx.orders || [];
    var history = ctx.history || [];

    return '<aside class="aside">' +
      '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
          '<span class="avatar" style="width:48px;height:48px;font-size:16px;background:var(--m3-primary-container);color:var(--m3-on-primary-container)">' +
            esc(initials(customer.name, customer.email)) + "</span>" +
          '<span style="min-width:0"><b style="display:block;font-size:15px">' + esc(customer.name || "Unknown name") + "</b>" +
            '<span style="display:block;font-size:12px;color:var(--m3-on-surface-variant)" class="ellipsis">' + esc(customer.email) + "</span></span>" +
        "</div>" +
        '<div style="display:flex;flex-direction:column;gap:10px">' +
          '<div class="kv"><span>Plan</span><strong>' + esc(ctx.plan || "free") + "</strong></div>" +
          '<div class="kv"><span>Account</span><strong>' + (ctx.has_account ? "Registered" : "No app account") + "</strong></div>" +
          '<div class="kv"><span>Known since</span><strong>' + esc(longDate(ctx.since)) + "</strong></div>" +
          '<div class="kv"><span>Lifetime value</span><strong class="mono">' + esc(money(ctx.ltv)) + "</strong></div>" +
        "</div>" +
        '<button type="button" class="btn" style="width:100%;margin-top:14px" data-act="nav" data-screen="customers">Open customer list</button>' +
      "</div>" +
      '<div class="card"><h3>Recent payments</h3><div class="rowlist">' +
        (orders.length ? orders.map(function (o) {
          return '<div style="display:flex;align-items:center;gap:12px">' +
            '<div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600">' + esc(o.plan) + " " + esc(o.period) + "</div>" +
            '<div style="font-size:11px;color:var(--m3-on-surface-variant)" class="mono">' + esc(amount(o.amount, o.currency)) + " · " + esc(longDate(o.created_at)) + "</div></div>" +
            '<span class="chip ' + (o.status === "paid" ? "chip-ok" : "") + '">' + esc(o.status) + "</span></div>";
        }).join("") : '<p style="font-size:13px;color:var(--m3-on-surface-variant);margin:0">No payments on this address.</p>') +
      "</div></div>" +
      '<div class="card"><h3>Past conversations</h3><div class="rowlist">' +
        (history.length ? history.map(function (h) {
          return '<div data-act="open" data-id="' + attr(h.id) + '" style="cursor:pointer">' +
            '<div style="font-size:13px;font-weight:500;line-height:19px">' + esc(h.subject) + "</div>" +
            '<div style="font-size:11px;color:var(--m3-on-surface-variant);margin-top:3px">' + esc(h.status) + " · " +
            esc(longDate(h.created_at)) + " · " + esc(h.messages) + " msg</div></div>";
        }).join("") : '<p style="font-size:13px;color:var(--m3-on-surface-variant);margin:0">This is their first ticket.</p>') +
      "</div></div>" +
      '<div class="card"><h3>Internal notes on this customer</h3>' +
        '<textarea class="field" id="customer-notes" style="height:110px" placeholder="Context worth keeping between tickets…" ' +
          (S.perms.note ? "" : "disabled") + ">" + esc(customer.notes || "") + "</textarea>" +
        (S.perms.note ? '<button type="button" class="btn btn-sm" style="margin-top:10px" data-act="save-notes" data-id="' + attr(customer.id) + '">Save</button>' : "") +
      "</div>" +
    "</aside>";
  }

  // --- all tickets ----------------------------------------------------------

  function renderAllTickets() {
    var rows = S.allTickets;
    if (!rows) return '<div class="screen"><div class="empty"><span class="spinner"></span></div></div>';
    return '<div class="screen"><div class="table">' +
      '<div class="tr head"><span>Ticket</span><span>Subject</span><span>Customer</span><span>Priority</span><span>Status</span><span>Assignee</span></div>' +
      (rows.length ? rows.map(function (t) {
        return '<div class="tr" data-act="open-from-list" data-id="' + attr(t.id) + '">' +
          '<span class="mono" style="font-size:12px;color:var(--m3-on-surface-variant)">SUP-' + esc(t.number) + "</span>" +
          '<span class="ellipsis" style="font-size:14px;font-weight:500">' + esc(t.subject) + "</span>" +
          '<span class="ellipsis" style="font-size:13px;color:var(--m3-on-surface-variant)">' + esc(t.customer_name || t.customer_email) + "</span>" +
          '<span class="' + priorityClass(t.priority) + '" style="justify-self:start">' + esc(t.priority) + "</span>" +
          '<span style="font-size:13px;color:var(--m3-on-surface-variant)">' + esc(t.status) + "</span>" +
          '<span class="ellipsis" style="font-size:13px;color:var(--m3-on-surface-variant)">' + esc(t.assignee_name || "—") + "</span>" +
        "</div>";
      }).join("") : '<div class="empty"><strong>No tickets yet</strong><p>They appear here the moment the first e-mail reaches contact@plately.eu.</p></div>') +
    "</div></div>";
  }

  // --- customers ------------------------------------------------------------

  function renderCustomers() {
    if (!S.customers) return '<div class="screen"><div class="empty"><span class="spinner"></span></div></div>';
    if (!S.customers.length) {
      return '<div class="screen"><div class="empty"><strong>No customers yet</strong><p>A customer record is created the first time someone writes in.</p></div></div>';
    }
    return '<div class="screen grid3">' + S.customers.map(function (c) {
      return '<div class="card" style="display:flex;flex-direction:column;gap:16px">' +
        '<div style="display:flex;align-items:center;gap:14px">' +
          '<span class="avatar" style="width:52px;height:52px;font-size:17px;background:var(--m3-surface-container-high);color:var(--m3-on-surface)">' +
            esc(initials(c.name, c.email)) + "</span>" +
          '<span style="min-width:0"><b style="display:block;font-size:16px">' + esc(c.name || "Unknown name") + "</b>" +
            '<span class="ellipsis" style="display:block;font-size:12px;color:var(--m3-on-surface-variant)">' + esc(c.email) + "</span></span>" +
          '<span class="chip ' + (c.plan !== "free" ? "chip-ok" : "") + '" style="margin-left:auto">' + esc(c.plan) + "</span>" +
        "</div>" +
        '<div style="display:flex;gap:24px">' +
          statBlock("Tickets", c.tickets) + statBlock("Open", c.open_tickets) + statBlock("Value", money(c.ltv)) +
        "</div>" +
        (c.notes ? '<p style="font-size:13px;line-height:20px;color:var(--m3-on-surface-variant);margin:0">' + esc(c.notes) + "</p>" : "") +
      "</div>";
    }).join("") + "</div>";
  }

  function statBlock(label, value) {
    return '<div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--m3-on-surface-variant)">' +
      esc(label) + '</div><div style="font-size:20px;font-weight:600;margin-top:2px">' + esc(value) + "</div></div>";
  }

  // --- reports --------------------------------------------------------------

  function renderReports() {
    var r = S.reports;
    if (!r) return '<div class="screen"><div class="empty"><span class="spinner"></span></div></div>';

    var series = r.series || [];
    var peak = series.reduce(function (max, d) { return Math.max(max, d.received, d.solved); }, 1);
    var agents = r.agents || [];
    var busiest = agents.reduce(function (max, a) { return Math.max(max, a.open); }, 1);
    var median = r.median_first_response_minutes;

    return '<div class="screen" style="display:flex;flex-direction:column;gap:24px">' +
      '<div class="stats">' +
        statCard("Received", r.received, "last " + r.range_days + " days") +
        statCard("Solved", r.solved, "in the same window") +
        statCard("Open now", r.open_now, (S.counts.overdue || 0) + " waiting over a day") +
        statCard("Median first reply", median === null || median === undefined ? "—" : formatMinutes(median), "from arrival to first answer") +
      "</div>" +
      '<div class="split">' +
        '<div class="card">' +
          "<h3>Received vs solved</h3>" +
          '<p style="font-size:13px;line-height:20px;color:var(--m3-on-surface-variant);margin:-6px 0 22px">Last ' + esc(r.range_days) + " days.</p>" +
          '<div class="chart">' + series.map(function (d) {
            return '<div class="col"><div class="bars">' +
              '<i class="in" style="height:' + Math.round((d.received / peak) * 100) + '%"></i>' +
              '<i class="out" style="height:' + Math.round((d.solved / peak) * 100) + '%"></i>' +
              '</div><span class="day">' + esc(String(d.day).slice(5)) + "</span></div>";
          }).join("") + "</div>" +
          '<div class="legend"><span><i style="background:var(--m3-primary)"></i>Received</span>' +
            '<span><i style="background:var(--m3-surface-container-highest)"></i>Solved</span></div>' +
        "</div>" +
        '<div class="card">' +
          "<h3>Agent workload</h3>" +
          '<div style="display:flex;flex-direction:column;gap:18px">' +
            (agents.length ? agents.map(function (a) {
              return '<div><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">' +
                '<span style="font-size:14px;font-weight:500">' + esc(a.name) + "</span>" +
                '<span class="mono" style="font-size:13px;color:var(--m3-on-surface-variant)">' + esc(a.open) + " open</span></div>" +
                '<div class="meter"><i style="width:' + Math.round((a.open / busiest) * 100) + '%"></i></div></div>';
            }).join("") : '<p style="font-size:13px;color:var(--m3-on-surface-variant);margin:0">No agents with tickets yet.</p>') +
          "</div>" +
          '<div style="margin-top:22px;display:flex;align-items:center;gap:12px;border-radius:16px;padding:14px 16px;background:var(--m3-secondary-container);color:var(--m3-on-secondary-container)">' +
            ICON.info + '<span style="font-size:13px;line-height:19px">' + esc(tagInsight(r.by_tag)) + "</span>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>";
  }

  function statCard(label, value, note) {
    return '<div class="card stat"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) +
      '</div><div class="note">' + esc(note) + "</div></div>";
  }

  function formatMinutes(minutes) {
    var m = Math.round(Number(minutes));
    if (m < 60) return m + " min";
    if (m < 60 * 24) return (m / 60).toFixed(1) + " h";
    return (m / 1440).toFixed(1) + " d";
  }

  function tagInsight(byTag) {
    var entries = Object.keys(byTag || {}).map(function (k) { return [k, byTag[k]]; });
    if (!entries.length) return "Not enough tagged tickets yet to say anything useful.";
    entries.sort(function (a, b) { return b[1] - a[1]; });
    return entries[0][0] + " is the biggest source right now — " + entries[0][1] + " ticket(s) in this window.";
  }

  // --- knowledge base -------------------------------------------------------

  function renderKb() {
    if (!S.articles) return '<div class="screen"><div class="empty"><span class="spinner"></span></div></div>';
    return '<div class="screen split">' +
      '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px">' +
          "<h3 style=\"margin:0\">Articles</h3>" +
          (S.perms.kb_write ? '<button type="button" class="btn btn-primary btn-sm" data-act="kb-new">New article</button>' : "") +
        "</div>" +
        '<div class="rowlist">' +
          (S.articles.length ? S.articles.map(function (a) {
            return '<div style="display:flex;align-items:center;gap:18px">' +
              '<div style="min-width:0;flex:1"><div style="font-size:15px;font-weight:600">' + esc(a.title) + "</div>" +
              '<div style="font-size:12px;color:var(--m3-on-surface-variant);margin-top:4px">' + esc(a.category) +
              " · updated " + esc(shortAge(a.updated_at)) + " ago</div></div>" +
              '<span class="chip ' + (a.state === "published" ? "chip-ok" : "") + '">' + esc(a.state) + "</span>" +
              (S.perms.kb_write ? '<button type="button" class="btn btn-sm" data-act="kb-edit" data-id="' + attr(a.id) + '">Edit</button>' : "") +
            "</div>";
          }).join("") : '<div class="empty"><strong>No articles yet</strong><p>Write the answer once, then link it from replies instead of retyping it.</p></div>') +
        "</div>" +
      "</div>" +
      '<div class="card"><h3>What this is for</h3>' +
        '<p style="font-size:13px;line-height:21px;color:var(--m3-on-surface-variant);margin:0">' +
        "An article is a canned answer with a life of its own: paste it into a reply, or send the link. " +
        "Macros under the composer cover the short ones; this is for the long ones worth maintaining.</p></div>" +
    "</div>";
  }

  // --- settings -------------------------------------------------------------

  function renderSettings() {
    var s = S.staff;
    var cards = [];

    cards.push('<div class="card">' +
      "<h3>Agent profile</h3>" +
      '<div class="rowlist">' +
        settingRow("Name", s.displayName, "From your Google account") +
        settingRow("E-mail", s.email, "This address is your login") +
        settingRow("Role", roleLabel(s), roleExplainer(s)) +
        settingRow("Last sign-in", s.lastLoginAt ? clockTime(s.lastLoginAt) : "First one", "Every sign-in is logged") +
      settingRow(
        "Authenticator",
        s.totpEnrolledAt ? "Linked" : "Not linked",
        s.totpEnrolledAt
          ? "Linked on " + longDate(s.totpEnrolledAt) + " — asked for at every sign-in"
          : "You will link one the next time you sign in"
      ) +
      "</div>" +
      '<label class="lbl" style="margin-top:18px">Your signature, appended to every reply you send</label>' +
      '<textarea class="field" id="signature" style="height:90px">' + esc(s.signature || "") + "</textarea>" +
      '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="save-signature">Save signature</button>' +
        '<button type="button" class="btn btn-sm" data-act="change-pin">Change PIN</button>' +
        '<button type="button" class="btn btn-sm" data-act="relink-totp">New phone</button>' +
      "</div>" +
    "</div>");

    if (S.perms.settings && S.settings) {
      cards.push('<div class="card">' +
        "<h3>E-mail channel</h3>" +
        '<p style="font-size:13px;line-height:21px;color:var(--m3-on-surface-variant);margin:-6px 0 16px">' +
          (S.mailConfigured
            ? "Mail leaves as " + esc(S.settings.from_name) + " &lt;" + esc(S.settings.from_email) + "&gt;. Anything arriving at that address lands in this inbox."
            : "No RESEND_API_KEY is set on this deployment, so nothing can be sent or received yet.") +
        "</p>" +
        '<label class="lbl">Sender name</label><input class="field" id="from_name" value="' + attr(S.settings.from_name) + '">' +
        '<label class="lbl" style="margin-top:12px">Sender address</label><input class="field" id="from_email" value="' + attr(S.settings.from_email) + '">' +
        '<label class="lbl" style="margin-top:12px">Desk signature (used when an agent has none)</label>' +
        '<textarea class="field" id="desk_signature" style="height:80px">' + esc(S.settings.signature) + "</textarea>" +
        '<label class="lbl" style="margin-top:12px">Auto-acknowledgement — {{ref}} becomes the ticket number</label>' +
        '<textarea class="field" id="auto_ack_body" style="height:110px">' + esc(S.settings.auto_ack_body) + "</textarea>" +
        '<div class="rowlist" style="margin-top:8px">' +
          toggleRow("auto_ack", "Send an auto-acknowledgement", "One automatic reply when a brand new ticket arrives. Never on follow-ups.", S.settings.auto_ack) +
          toggleRow("auto_assign", "Assign new tickets to whoever replies first", "Otherwise a ticket stays unassigned until someone claims it.", S.settings.auto_assign) +
        "</div>" +
        '<button type="button" class="btn btn-primary btn-sm" style="margin-top:14px" data-act="save-settings">Save desk settings</button>' +
      "</div>");
    }

    if (S.perms.maintenance) {
      var mode = S.maintenance;
      cards.push('<div class="card">' +
        "<h3>Site control</h3>" +
        '<p style="font-size:13px;line-height:21px;color:var(--m3-on-surface-variant);margin:-6px 0 14px">' +
          "plately.eu answers 503 with the maintenance page while this is on. The app at app.plately.eu is unaffected, and the switch takes effect immediately — no redeploy.</p>" +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
          '<span style="font-size:13px;color:var(--m3-on-surface-variant)">Current mode</span>' +
          (mode === null
            ? '<span class="spinner"></span>'
            : '<span class="mode-badge ' + (mode === "maintenance" ? "mode-maintenance" : "mode-live") + '">' +
              (mode === "maintenance" ? "MAINTENANCE" : "LIVE") + "</span>") +
        "</div>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="site-mode" data-mode="live">Put the site live</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-act="site-mode" data-mode="maintenance">Take the site down</button>' +
        "</div>" +
      "</div>");
    }

    cards.push(renderTeamCard());

    cards.push('<div class="card" style="display:flex;flex-direction:column;gap:16px">' +
      "<h3 style=\"margin:0\">Session</h3>" +
      '<p style="font-size:13px;line-height:21px;color:var(--m3-on-surface-variant);margin:0">' +
      "Signed in as " + esc(s.email) + " on this device. The session lasts twelve hours, then Google, " +
      "your PIN and a code from your authenticator are all asked for again.</p>" +
      '<button type="button" class="btn btn-danger" style="align-self:flex-start" data-act="signout">Sign out</button>' +
    "</div>");

    return '<div class="screen grid2">' + cards.join("") + "</div>";
  }

  function roleExplainer(staff) {
    if (staff.role === "owner") return "Everything, including who else gets in";
    if (staff.role === "admin") return "Everything except managing roles";
    if (staff.role === "viewer") return "Read-only across the desk";
    if (staff.tier >= 3) return "Can reopen, delete and mark spam";
    if (staff.tier === 2) return "Can escalate, refund and reassign";
    return "Can reply, note, tag and solve";
  }

  function settingRow(label, value, hint) {
    return '<div class="setting-row" style="border-top:1px solid var(--m3-outline-variant)">' +
      '<div class="t"><b>' + esc(label) + "</b><span>" + esc(hint) + "</span></div>" +
      '<span style="flex:none;font-size:13px;color:var(--m3-on-surface-variant);text-align:right">' + esc(value) + "</span></div>";
  }

  function toggleRow(key, label, hint, on) {
    return '<div class="setting-row">' +
      '<div class="t"><b>' + esc(label) + "</b><span>" + esc(hint) + "</span></div>" +
      '<button type="button" class="toggle ' + (on ? "on" : "") + '" data-act="toggle" data-key="' + key + '"><i></i></button></div>';
  }

  function renderTeamCard() {
    var canManage = S.perms.staff_write;
    var rows = S.staffList;
    return '<div class="card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px">' +
        "<h3 style=\"margin:0\">Team and roles</h3>" +
        (canManage ? '<button type="button" class="btn btn-primary btn-sm" data-act="invite">Add agent</button>' : "") +
      "</div>" +
      (rows === null || rows === undefined
        ? '<div class="empty"><span class="spinner"></span></div>'
        : '<div class="rowlist">' + rows.map(function (m) {
            return '<div style="display:flex;align-items:center;gap:12px">' +
              '<span class="avatar" style="width:36px;height:36px;font-size:13px">' + esc(initials(m.display_name, m.email)) + "</span>" +
              '<div style="min-width:0;flex:1"><div style="font-size:14px;font-weight:600">' + esc(m.display_name || m.email) + "</div>" +
              '<div class="ellipsis" style="font-size:12px;color:var(--m3-on-surface-variant)">' + esc(m.email) +
              (m.hasPin ? "" : " · PIN not set") + (m.hasTotp ? "" : " · no authenticator") +
              (m.active ? "" : " · deactivated") + "</div></div>" +
              '<span class="chip">' + esc(m.role === "agent" ? "agent T" + m.tier : m.role) + "</span>" +
              (canManage && m.id !== S.staff.id
                ? '<button type="button" class="btn btn-sm" data-act="edit-staff" data-id="' + attr(m.id) + '">Edit</button>'
                : "") +
            "</div>";
          }).join("") + "</div>") +
      '<p style="font-size:12px;line-height:18px;color:var(--m3-on-surface-variant);margin:14px 0 0">' +
      "Adding someone here is the whole invitation: they sign in with that Google address, choose their own PIN " +
      "and link their own authenticator app on first run. Nothing is e-mailed.</p>" +
    "</div>";
  }

  // -------------------------------------------------------------------------
  // overlays
  // -------------------------------------------------------------------------

  function closeOverlay() {
    overlay.innerHTML = "";
    document.removeEventListener("keydown", overlayKeys);
  }

  function overlayKeys(event) {
    if (event.key === "Escape") closeOverlay();
  }

  function showModal(inner) {
    overlay.innerHTML = '<div class="scrim" data-act="scrim"><div class="modal">' + inner + "</div></div>";
    document.addEventListener("keydown", overlayKeys);
    var first = overlay.querySelector("input, textarea");
    if (first) first.focus();
  }

  function showMenu(anchor, items) {
    var rect = anchor.getBoundingClientRect();
    var html = '<div class="menu" style="left:' + Math.min(rect.left, window.innerWidth - 240) + "px;top:" + (rect.bottom + 6) + 'px">' +
      items.map(function (item) {
        if (item.header) return '<div class="h">' + esc(item.header) + "</div>";
        if (item.sep) return '<div class="sep"></div>';
        return '<button type="button" class="' + (item.on ? "on" : "") + '" data-act="' + attr(item.act) + '" data-value="' + attr(item.value) + '">' +
          esc(item.label) + "</button>";
      }).join("") + "</div>";
    overlay.innerHTML = '<div class="scrim" data-act="scrim" style="background:transparent">' + html + "</div>";
    document.addEventListener("keydown", overlayKeys);
  }

  function composeModal() {
    showModal(
      '<div class="modal-head"><h2>New ticket</h2>' +
        '<span style="font-size:12px;color:var(--m3-on-surface-variant)">Outbound e-mail, logged as a conversation</span>' +
        '<button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<input class="field" id="c-email" placeholder="Customer e-mail">' +
      '<input class="field" id="c-name" placeholder="Their name (optional)">' +
      '<input class="field" id="c-subject" placeholder="Subject">' +
      '<textarea class="field" id="c-body" style="height:160px" placeholder="Write the first message…"></textarea>' +
      '<div style="display:flex;gap:10px">' +
        '<select class="field" id="c-priority">' + ["normal", "low", "high", "urgent"].map(function (p) {
          return '<option value="' + p + '">' + p + " priority</option>";
        }).join("") + "</select>" +
        '<select class="field" id="c-tag"><option value="">no tag</option>' + S.tags.map(function (t) {
          return '<option value="' + attr(t) + '">' + esc(t) + "</option>";
        }).join("") + "</select>" +
      "</div>" +
      '<div class="foot"><button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="create-ticket">Create and send</button></div>'
    );
  }

  function shortcutsModal() {
    showModal(
      '<div class="modal-head"><h2>Keyboard shortcuts</h2><button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      SHORTCUTS.map(function (s) {
        return '<div class="shortcut"><span>' + esc(s.label) + "</span><kbd>" + esc(s.key) + "</kbd></div>";
      }).join("")
    );
  }

  function pinModal() {
    showModal(
      '<div class="modal-head"><h2>Change your PIN</h2><button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<label class="lbl">Current PIN</label><input class="field" id="pin-old" inputmode="numeric" maxlength="4" type="password">' +
      '<label class="lbl">New PIN</label><input class="field" id="pin-new" inputmode="numeric" maxlength="4" type="password">' +
      '<label class="lbl">Repeat the new PIN</label><input class="field" id="pin-confirm" inputmode="numeric" maxlength="4" type="password">' +
      '<div class="foot"><button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="submit-pin-change">Change PIN</button></div>'
    );
  }

  /**
   * Moving the authenticator to a new phone, in two halves.
   *
   * The PIN is asked for first because a live session is not enough: the
   * authenticator exists precisely to survive a session being taken over, so
   * letting a session alone move it would undo the point of having it.
   */
  function relinkModal() {
    showModal(
      '<div class="modal-head"><h2>Move your authenticator</h2>' +
        '<button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<p style="font-size:13px;line-height:20px;color:var(--m3-on-surface-variant);margin:0">' +
      "For a new phone, or a new authenticator app. Your PIN confirms it is really you — a signed-in " +
      "browser on its own is not enough to move a second factor.</p>" +
      '<label class="lbl">Your current PIN</label>' +
      '<input class="field" id="relink-pin" inputmode="numeric" maxlength="4" type="password">' +
      '<div class="foot"><button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="submit-relink">Show the new code</button></div>'
    );
  }

  function relinkConfirmModal(data) {
    showModal(
      '<div class="modal-head"><h2>Scan this on the new phone</h2>' +
        '<button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<p style="font-size:13px;line-height:20px;color:var(--m3-on-surface-variant);margin:0">' +
      "Your old authenticator has stopped working already. Scan this, then type the code it gives you — " +
      "until you do, your next sign-in will ask you to link one again.</p>" +
      '<div class="enrol enrol-modal">' +
        '<div class="enrol-qr">' + data.qr + "</div>" +
        '<div class="enrol-side">' +
          '<div class="enrol-secret"><span class="lbl">Or enter this key by hand</span>' +
          "<code>" + esc(data.secret) + "</code></div>" +
        "</div>" +
      "</div>" +
      '<label class="lbl">The six digits from the app</label>' +
      '<input class="field" id="relink-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">' +
      '<div class="foot"><button type="button" class="btn" data-act="close">Finish later</button>' +
        '<button type="button" class="btn btn-primary" data-act="submit-relink-confirm">Confirm the new phone</button></div>'
    );
  }

  function inviteModal() {
    showModal(
      '<div class="modal-head"><h2>Add an agent</h2><button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<p style="font-size:13px;line-height:20px;color:var(--m3-on-surface-variant);margin:0">' +
      "The address must be the Google account they will sign in with. Nothing is e-mailed — they just open /support and sign in.</p>" +
      '<input class="field" id="i-email" placeholder="agent@gmail.com">' +
      '<input class="field" id="i-name" placeholder="Name (optional)">' +
      '<div style="display:flex;gap:10px">' +
        '<select class="field" id="i-role">' +
          '<option value="agent">agent</option><option value="viewer">viewer</option>' +
          '<option value="admin">admin</option><option value="owner">owner</option>' +
        "</select>" +
        '<select class="field" id="i-tier"><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select>' +
      "</div>" +
      '<div class="foot"><button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="submit-invite">Add to the team</button></div>'
    );
  }

  function editStaffModal(member) {
    showModal(
      '<div class="modal-head"><h2>' + esc(member.display_name || member.email) + '</h2><button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<label class="lbl">Role</label>' +
      '<select class="field" id="e-role">' + ["owner", "admin", "agent", "viewer"].map(function (r) {
        return '<option value="' + r + '" ' + (member.role === r ? "selected" : "") + ">" + r + "</option>";
      }).join("") + "</select>" +
      '<label class="lbl" style="margin-top:12px">Tier (agents only)</label>' +
      '<select class="field" id="e-tier">' + [1, 2, 3].map(function (t) {
        return '<option value="' + t + '" ' + (Number(member.tier) === t ? "selected" : "") + ">Tier " + t + "</option>";
      }).join("") + "</select>" +
      '<div class="setting-row" style="margin-top:8px"><div class="t"><b>Active</b><span>Deactivating ends their access on the next request</span></div>' +
        '<button type="button" class="toggle ' + (member.active ? "on" : "") + '" data-act="toggle-active"><i></i></button></div>' +
      '<div class="foot" style="flex-wrap:wrap">' +
        '<button type="button" class="btn btn-danger" data-act="reset-staff-pin" data-id="' + attr(member.id) + '">Reset PIN</button>' +
        '<button type="button" class="btn btn-danger" data-act="reset-staff-totp" data-id="' + attr(member.id) + '">Unlink authenticator</button>' +
        '<button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="submit-staff" data-id="' + attr(member.id) + '">Save</button>' +
      "</div>"
    );
  }

  function articleModal(article) {
    var a = article || { title: "", category: "General", body: "", state: "draft" };
    showModal(
      '<div class="modal-head"><h2>' + (article ? "Edit article" : "New article") + '</h2>' +
      '<button type="button" class="btn btn-icon x" data-act="close">✕</button></div>' +
      '<input class="field" id="a-title" placeholder="Title" value="' + attr(a.title) + '">' +
      '<input class="field" id="a-category" placeholder="Category" value="' + attr(a.category) + '">' +
      '<textarea class="field" id="a-body" style="height:220px" placeholder="The answer, written once…">' + esc(a.body || "") + "</textarea>" +
      '<select class="field" id="a-state">' + ["draft", "published", "archived"].map(function (s) {
        return '<option value="' + s + '" ' + (a.state === s ? "selected" : "") + ">" + s + "</option>";
      }).join("") + "</select>" +
      '<div class="foot">' +
        (article ? '<button type="button" class="btn btn-danger" data-act="kb-delete" data-id="' + attr(article.id) + '">Delete</button>' : "") +
        '<button type="button" class="btn" data-act="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-act="kb-save" data-id="' + attr(article ? article.id : "") + '">Save</button>' +
      "</div>"
    );
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------

  var ACTIONS = {
    google: function () {
      var button = document.querySelector('[data-act="google"]');
      if (button) button.disabled = true;
      api("/api/staff/start", { method: "POST" })
        .then(function (data) { location.href = data.url; })
        .catch(function (err) {
          S.error = err.message;
          render();
        });
    },

    "pin-submit": function () {
      var setup = S.phase === "pin_setup";
      var pin = readPin("a");
      if (pin.length !== 4) { S.error = "Four digits, please."; return render(); }
      var body = { pin: pin, turnstileToken: S.turnstile.token };
      if (setup) body.confirm = readPin("b");
      S.error = "";
      api(setup ? "/api/staff/pin-setup" : "/api/staff/pin", { method: "POST", body: body })
        .then(function (data) {
          // The last gate. This is where the desk actually opens.
          S.staff = data.staff;
          S.perms = data.permissions || {};
          S.error = "";
          history.replaceState(null, "", "/support");
          loadDesk();
        })
        .catch(function (err) {
          S.error = err.message;
          resetTurnstile();
          if (err.data && err.data.state === "pin_setup") S.phase = "pin_setup";
          render();
          clearPins();
        });
    },

    "totp-submit": function () {
      var code = readDigits("a", 6);
      if (code.length !== 6) { S.error = "Six digits, please."; return render(); }
      S.error = "";
      api("/api/staff/totp", { method: "POST", body: { code: code, turnstileToken: S.turnstile.token } })
        .then(function (data) {
          // A correct code does not open the desk — it advances to the PIN.
          // The server names the next step; the browser does not get to decide.
          S.error = "";
          S.enrol = null;
          S.showSecret = false;
          S.turnstile.token = null;
          S.phase = data.state || "pin_required";
          history.replaceState(null, "", "/support");
          render();
        })
        .catch(function (err) {
          S.error = err.message;
          resetTurnstile();
          if (err.data && err.data.state === "totp_setup") S.phase = "totp_setup";
          render();
          clearPins();
        });
    },

    "show-secret": function () { S.showSecret = true; render(); },

    "ai-draft": function () {
      if (!S.selectedId || S.aiBusy) return;
      var id = S.selectedId;
      saveDraft();
      S.aiBusy = true;
      render();
      api("/api/support/ai-draft", { method: "POST", body: { ticketId: id } })
        .then(function (data) {
          S.aiBusy = false;
          S.aiDrafts[id] = {
            id: data.draftId, text: data.draft, model: data.model,
            articlesUsed: data.articlesUsed, rating: 0,
          };
          // Straight into the box, because the agent is going to edit it there
          // anyway and a preview they have to copy out of is a wasted step.
          // Anything already typed is kept above it rather than thrown away.
          var typed = (S.drafts[id] || "").trim();
          S.drafts[id] = typed ? typed + "\n\n" + data.draft : data.draft;
          render();
          focusComposer();
        })
        .catch(function (err) {
          S.aiBusy = false;
          render();
          toast(err.message, true);
        });
    },

    "ai-rate": function (el) {
      var draft = S.aiDrafts[S.selectedId];
      if (!draft || !draft.id) return;
      var rating = Number(el.dataset.rating);
      // Optimistic: the thumb is a hint to the next prompt, not a transaction,
      // and waiting on a round trip to colour a button reads as broken.
      draft.rating = rating;
      render();
      api("/api/support/ai-feedback", { method: "POST", body: { draftId: draft.id, rating: rating } })
        .then(function () {
          toast(rating === 1
            ? "Noted — answers like this will be shown to the model as examples"
            : "Noted — the model will be told not to answer like that again");
        })
        .catch(function (err) { draft.rating = 0; render(); toast(err.message, true); });
    },

    "ai-discard": function () {
      delete S.aiDrafts[S.selectedId];
      render();
    },

    "enrol-again": function () {
      if (!confirm("Throw away the code on screen and generate a new one? Anything you already scanned stops working.")) return;
      S.enrolBusy = true;
      S.showSecret = false;
      api("/api/staff/totp-enrol", { method: "POST", body: { regenerate: true } })
        .then(function (data) { S.enrol = data; S.enrolBusy = false; render(); })
        .catch(function (err) { S.enrolBusy = false; toast(err.message, true); });
    },

    signout: function () {
      api("/api/staff/logout", { method: "POST" }).then(function () { location.href = "/support"; });
    },

    nav: function (el) { closeOverlay(); loadScreen(el.dataset.screen); },

    view: function (el) {
      S.view = el.dataset.view;
      S.screen = "inbox";
      S.selectedId = null;
      S.detail = null;
      render();
      refreshTickets(true);
    },

    "clear-filters": function () {
      S.view = "all_open";
      S.search = "";
      refreshTickets(true);
    },

    sort: function () {
      S.sort = S.sort === "age" ? "newest" : S.sort === "newest" ? "priority" : "age";
      refreshTickets(false);
    },

    open: function (el) { closeOverlay(); openTicket(el.dataset.id); },

    "open-from-list": function (el) {
      S.screen = "inbox";
      S.view = "all";
      closeOverlay();
      refreshTickets(false).then(function () { openTicket(el.dataset.id); });
    },

    theme: function () {
      var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("plately_support_theme", next);
      render();
    },

    shortcuts: function () { shortcutsModal(); },
    compose: function () { composeModal(); },
    close: function () { closeOverlay(); },
    scrim: function (el, event) { if (event.target === el) closeOverlay(); },

    kind: function (el) {
      saveDraft();
      S.composerKind = el.dataset.kind;
      render();
      var box = document.getElementById("composer");
      if (box) box.focus();
    },

    macro: function (el) {
      var macro = S.macros.filter(function (m) { return m.id === el.dataset.id; })[0];
      if (!macro) return;
      var box = document.getElementById("composer");
      if (!box) return;
      box.value = box.value ? box.value.trimEnd() + "\n\n" + macro.body : macro.body;
      box.focus();
      saveDraft();
    },

    send: function (el) { sendMessage(el.dataset.solve === "1"); },

    status: function (el) {
      patchTicket({ status: el.dataset.status });
    },

    escalate: function () { patchTicket({ escalate: true }); },

    "menu-assign": function (el) {
      var items = [{ header: "Assign to" }];
      if (S.perms.assign_self) items.push({ label: "Me", act: "assign", value: S.staff.id, on: S.detail.ticket.assignee_id === S.staff.id });
      if (S.perms.assign_other) {
        S.team.forEach(function (m) {
          if (m.id === S.staff.id) return;
          items.push({ label: m.display_name || m.email, act: "assign", value: m.id, on: S.detail.ticket.assignee_id === m.id });
        });
      }
      items.push({ sep: true });
      items.push({ label: "Nobody", act: "assign", value: "" });
      showMenu(el, items);
    },

    assign: function (el) { closeOverlay(); patchTicket({ assigneeId: el.dataset.value || null }); },

    "menu-more": function (el) {
      var items = [{ header: "Careful with these" }];
      if (S.perms.solve) items.push({ label: "Close for good", act: "status-menu", value: "closed" });
      if (S.perms.spam) items.push({ label: "Mark as spam", act: "status-menu", value: "spam" });
      if (S.perms["delete"]) {
        items.push({ sep: true });
        items.push({ label: "Delete this ticket", act: "delete-ticket", value: S.selectedId });
      }
      showMenu(el, items);
    },

    "status-menu": function (el) { closeOverlay(); patchTicket({ status: el.dataset.value }); },

    "delete-ticket": function (el) {
      closeOverlay();
      if (!confirm("Delete this ticket and its whole history? This cannot be undone.")) return;
      api("/api/support/ticket-delete", { method: "POST", body: { ticketId: el.dataset.value } })
        .then(function () {
          S.selectedId = null;
          S.detail = null;
          toast("Ticket deleted");
          refreshTickets(true);
        })
        .catch(function (err) { toast(err.message, true); });
    },

    "menu-priority": function (el) {
      showMenu(el, [{ header: "Priority" }].concat(S.priorities.map(function (p) {
        return { label: p, act: "priority", value: p, on: S.detail.ticket.priority === p };
      })));
    },

    priority: function (el) { closeOverlay(); patchTicket({ priority: el.dataset.value }); },

    "menu-tag": function (el) {
      showMenu(el, [{ header: "Tag" }].concat(S.tags.map(function (t) {
        return { label: t, act: "tag", value: t, on: S.detail.ticket.tag === t };
      })).concat([{ sep: true }, { label: "No tag", act: "tag", value: "" }]));
    },

    tag: function (el) { closeOverlay(); patchTicket({ tag: el.dataset.value || null }); },

    "create-ticket": function (el) {
      var body = {
        email: value("c-email"),
        name: value("c-name"),
        subject: value("c-subject"),
        body: value("c-body"),
        priority: value("c-priority"),
        tag: value("c-tag") || null,
      };
      busy(el, true);
      api("/api/support/ticket", { method: "POST", body: body })
        .then(function (data) {
          closeOverlay();
          toast("Sent — SUP-" + data.number + " is open");
          S.view = "all_open";
          refreshTickets(false).then(function () { openTicket(data.ticketId); });
        })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "save-notes": function (el) {
      var notes = value("customer-notes");
      api("/api/support/customer-notes", { method: "POST", body: { customerId: el.dataset.id, notes: notes } })
        .then(function () { toast("Saved"); })
        .catch(function (err) { toast(err.message, true); });
    },

    "save-signature": function (el) {
      busy(el, true);
      api("/api/support/profile", { method: "POST", body: { signature: value("signature") } })
        .then(function (data) { S.staff.signature = data.signature; busy(el, false); toast("Signature saved"); })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    toggle: function (el) {
      var key = el.dataset.key;
      S.settings[key] = !S.settings[key];
      el.classList.toggle("on", S.settings[key]);
    },

    "toggle-active": function (el) { el.classList.toggle("on"); },

    "save-settings": function (el) {
      busy(el, true);
      api("/api/support/settings", {
        method: "POST",
        body: {
          from_name: value("from_name"),
          from_email: value("from_email"),
          signature: value("desk_signature"),
          auto_ack_body: value("auto_ack_body"),
          auto_ack: S.settings.auto_ack,
          auto_assign: S.settings.auto_assign,
        },
      }).then(function (data) {
        S.settings = data.settings;
        busy(el, false);
        toast("Desk settings saved");
      }).catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "site-mode": function (el) {
      var mode = el.dataset.mode;
      if (mode === "maintenance" && !confirm("Take plately.eu offline for visitors? The app keeps running.")) return;
      busy(el, true);
      api("/api/support/maintenance", { method: "POST", body: { mode: mode } })
        .then(function (data) { S.maintenance = data.mode; busy(el, false); render(); toast("Site is now " + data.mode); })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "change-pin": function () { pinModal(); },

    "submit-pin-change": function (el) {
      busy(el, true);
      api("/api/staff/pin-change", {
        method: "POST",
        body: { currentPin: value("pin-old"), pin: value("pin-new"), confirm: value("pin-confirm") },
      }).then(function () { closeOverlay(); toast("PIN changed"); })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    invite: function () { inviteModal(); },

    "submit-invite": function (el) {
      busy(el, true);
      api("/api/staff/invite", {
        method: "POST",
        body: { email: value("i-email"), displayName: value("i-name"), role: value("i-role"), tier: Number(value("i-tier")) },
      }).then(function () {
        closeOverlay();
        S.staffList = null;
        loadScreen("settings");
        toast("Added — they can sign in now");
      }).catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "edit-staff": function (el) {
      var member = (S.staffList || []).filter(function (m) { return m.id === el.dataset.id; })[0];
      if (member) editStaffModal(member);
    },

    "submit-staff": function (el) {
      var active = overlay.querySelector('[data-act="toggle-active"]').classList.contains("on");
      busy(el, true);
      api("/api/staff/update", {
        method: "POST",
        body: { id: el.dataset.id, role: value("e-role"), tier: Number(value("e-tier")), active: active },
      }).then(function () {
        closeOverlay();
        S.staffList = null;
        S.team = [];
        loadScreen("settings");
        toast("Saved");
      }).catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "reset-staff-pin": function (el) {
      if (!confirm("Clear this agent's PIN? They will choose a new one on their next sign-in.")) return;
      api("/api/staff/reset-pin", { method: "POST", body: { id: el.dataset.id } })
        .then(function () { closeOverlay(); S.staffList = null; loadScreen("settings"); toast("PIN cleared"); })
        .catch(function (err) { toast(err.message, true); });
    },

    "reset-staff-totp": function (el) {
      if (!confirm("Unlink this agent's authenticator? Do this only when they have actually lost the phone — they will link a new one on their next sign-in.")) return;
      api("/api/staff/reset-totp", { method: "POST", body: { id: el.dataset.id } })
        .then(function () { closeOverlay(); S.staffList = null; loadScreen("settings"); toast("Authenticator unlinked"); })
        .catch(function (err) { toast(err.message, true); });
    },

    "relink-totp": function () { relinkModal(); },

    "submit-relink": function (el) {
      busy(el, true);
      api("/api/staff/totp-relink", { method: "POST", body: { currentPin: value("relink-pin") } })
        .then(function (data) {
          closeOverlay();
          relinkConfirmModal(data);
          // The old phone is already dead at this point, so the profile card
          // must stop claiming otherwise even if the confirm is abandoned.
          if (S.staff) S.staff.totpEnrolledAt = null;
        })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "submit-relink-confirm": function (el) {
      busy(el, true);
      api("/api/staff/totp-relink-confirm", { method: "POST", body: { code: value("relink-code") } })
        .then(function () {
          closeOverlay();
          if (S.staff) S.staff.totpEnrolledAt = new Date().toISOString();
          render();
          toast("New authenticator linked");
        })
        .catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "kb-new": function () { articleModal(null); },

    "kb-edit": function (el) {
      var article = (S.articles || []).filter(function (a) { return a.id === el.dataset.id; })[0];
      if (article) articleModal(article);
    },

    "kb-save": function (el) {
      busy(el, true);
      api("/api/support/kb-save", {
        method: "POST",
        body: {
          id: el.dataset.id || undefined,
          title: value("a-title"),
          category: value("a-category"),
          body: value("a-body"),
          state: value("a-state"),
        },
      }).then(function () {
        closeOverlay();
        S.articles = null;
        loadScreen("kb");
        toast("Saved");
      }).catch(function (err) { busy(el, false); toast(err.message, true); });
    },

    "kb-delete": function (el) {
      if (!confirm("Delete this article?")) return;
      api("/api/support/kb-delete", { method: "POST", body: { id: el.dataset.id } })
        .then(function () { closeOverlay(); S.articles = null; loadScreen("kb"); toast("Deleted"); })
        .catch(function (err) { toast(err.message, true); });
    },
  };

  function value(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function busy(el, on) {
    if (!el) return;
    el.disabled = on;
    el.style.opacity = on ? ".6" : "";
  }

  function saveDraft() {
    var box = document.getElementById("composer");
    if (box && S.selectedId) S.drafts[S.selectedId] = box.value;
  }

  function sendMessage(solve) {
    var box = document.getElementById("composer");
    if (!box || !box.value.trim() || !S.selectedId) return;
    var text = box.value;
    var kind = S.composerKind;
    var button = document.querySelector('[data-act="send"]');
    busy(button, true);
    var aiDraft = S.aiDrafts[S.selectedId];
    api("/api/support/message", {
      method: "POST",
      body: {
        ticketId: S.selectedId, body: text, kind: kind,
        solve: Boolean(solve) && kind === "reply",
        // Lets the server compare what the model wrote with what was actually
        // sent. That difference is the agent correcting it, and it is worth
        // more than the thumb.
        draftId: aiDraft && kind === "reply" ? aiDraft.id : undefined,
      },
    }).then(function (data) {
      delete S.drafts[S.selectedId];
      delete S.aiDrafts[S.selectedId];
      S.detail = data.detail;
      render();
      scrollThreadToEnd();
      toast(kind === "note" ? "Note saved" : solve ? "Sent and marked solved" : "Reply sent");
      refreshTickets(false);
    }).catch(function (err) {
      busy(button, false);
      toast(err.message, true);
    });
  }

  function patchTicket(patch) {
    if (!S.selectedId) return;
    var body = Object.assign({ ticketId: S.selectedId }, patch);
    api("/api/support/ticket-update", { method: "POST", body: body })
      .then(function (data) {
        S.detail = data.detail;
        render();
        refreshTickets(false);
      })
      .catch(function (err) { toast(err.message, true); });
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  document.addEventListener("click", function (event) {
    var el = event.target.closest("[data-act]");
    if (!el) return;
    var action = ACTIONS[el.dataset.act];
    if (!action) return;
    action(el, event);
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (target.id === "composer") {
      saveDraft();
      return;
    }
    if (target.classList && target.classList.contains("pin-box")) {
      var boxes = Array.prototype.slice.call(target.parentNode.querySelectorAll(".pin-box"));
      var start = boxes.indexOf(target);
      var digits = target.value.replace(/\D/g, "");
      target.value = digits.charAt(0) || "";
      for (var i = 1; i < digits.length && start + i < boxes.length; i++) {
        boxes[start + i].value = digits.charAt(i);
      }
      boxes.forEach(function (box) { box.classList.toggle("filled", Boolean(box.value)); });
      var landing = boxes.slice(start).filter(function (box) { return !box.value; })[0] ||
        boxes[Math.min(boxes.length - 1, start + Math.max(digits.length, 1))] || target;
      landing.focus();
    }
  });

  document.addEventListener("keydown", function (event) {
    // Digit boxes: backspace walks back, Enter submits whichever step is up.
    if (event.target.classList && event.target.classList.contains("pin-box")) {
      if (event.key === "Backspace" && !event.target.value) {
        var prev = event.target.previousElementSibling;
        if (prev && prev.classList.contains("pin-box")) { prev.focus(); prev.value = ""; }
      }
      if (event.key === "Enter") {
        var totpPhase = S.phase === "totp_required" || S.phase === "totp_setup";
        ACTIONS[totpPhase ? "totp-submit" : "pin-submit"]();
      }
      return;
    }

    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.id === "composer") {
      event.preventDefault();
      sendMessage(false);
      return;
    }

    if (event.key === "Escape") {
      closeOverlay();
      if (typing) event.target.blur();
      return;
    }

    if (typing || S.phase !== "ready") return;

    var key = event.key.toLowerCase();
    if (key === "/") { event.preventDefault(); var search = document.getElementById("search"); if (search) search.focus(); }
    else if (key === "n" && S.perms.reply) { event.preventDefault(); composeModal(); }
    else if (key === "?") shortcutsModal();
    else if (key === "t") ACTIONS.theme();
    else if (key === "j" || key === "k") { event.preventDefault(); step(key === "j" ? 1 : -1); }
    else if (key === "r" && S.detail) { S.composerKind = "reply"; render(); focusComposer(); }
    else if (key === "m" && S.detail) { S.composerKind = "note"; render(); focusComposer(); }
    else if (key === "a" && S.detail && S.perms.assign_self) patchTicket({ assigneeId: S.staff.id });
    else if (key === "e" && S.detail && S.perms.solve) patchTicket({ status: "solved" });
  });

  function focusComposer() {
    var box = document.getElementById("composer");
    if (box) box.focus();
  }

  function step(delta) {
    if (!S.tickets.length) return;
    var index = S.tickets.findIndex(function (t) { return t.id === S.selectedId; });
    var next = Math.min(S.tickets.length - 1, Math.max(0, (index < 0 ? 0 : index + delta)));
    openTicket(S.tickets[next].id);
  }

  var searchTimer = null;
  document.addEventListener("input", function (event) {
    if (event.target.id !== "search") return;
    S.search = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (S.screen !== "inbox") { S.screen = "inbox"; }
      refreshTickets(false).then(function () {
        var search = document.getElementById("search");
        if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
      });
    }, 320);
  });

  // A quiet poll rather than a socket: the inbox is allowed to be thirty
  // seconds stale, and this survives a laptop lid closing without reconnect
  // logic. It never touches the open conversation, so it cannot eat a draft.
  setInterval(function () {
    if (S.phase !== "ready" || document.hidden) return;
    if (S.screen !== "inbox") return;
    if (overlay.innerHTML) return;
    api("/api/support/tickets?view=" + encodeURIComponent(S.view) + "&sort=" + encodeURIComponent(S.sort) +
        (S.search ? "&search=" + encodeURIComponent(S.search) : ""))
      .then(function (data) {
        var before = S.tickets.length;
        S.tickets = data.tickets || [];
        S.counts = data.counts || S.counts;
        saveDraft();
        render();
        if (S.tickets.length > before) toast("New mail in " + currentViewLabel());
      })
      .catch(function () { /* a failed poll is not worth interrupting anyone */ });
  }, 30000);

  boot();
})();
