// ============================================================================
// Error-page copy.
//
// Drives both the dedicated 404.html and the catch-all error.html. The page
// ships with correct Polish already in the markup, so this only has to
// (a) translate for non-Polish readers and (b) fill in the specific code on
// error.html, which cannot know it at build time.
//
// Two languages rather than the landing page's twelve: an error page is a
// dead end someone leaves within seconds, and 156 hand-written strings that
// nobody reads is maintenance debt, not thoroughness.
// ============================================================================

(function () {
  'use strict';

  var COMMON = {
    pl: { home: 'Strona główna', app: 'Otwórz aplikację', errLabel: 'Błąd' },
    en: { home: 'Home', app: 'Open the app', errLabel: 'Error' }
  };

  // slug mirrors what the platform puts in its own error responses, so a
  // screenshot of this page is enough to find the request in the logs.
  var CODES = {
    400: {
      slug: 'BAD_REQUEST',
      pl: { title: 'Nie zrozumieliśmy tego żądania', lead: 'Adres albo dane w nim zawarte są nieprawidłowe. Spróbuj wejść jeszcze raz od strony głównej.' },
      en: { title: 'We could not read that request', lead: 'The address or the data in it is malformed. Try again from the homepage.' }
    },
    401: {
      slug: 'UNAUTHORIZED',
      pl: { title: 'Musisz się zalogować', lead: 'Ta część serwisu wymaga zalogowania. Jeśli masz konto, zaloguj się i spróbuj ponownie.' },
      en: { title: 'You need to sign in', lead: 'This part of the site requires an account. Sign in and try again.' }
    },
    403: {
      slug: 'FORBIDDEN',
      pl: { title: 'Nie masz dostępu do tej strony', lead: 'Twoje konto nie ma uprawnień do tego zasobu. Jeśli to pomyłka, wróć na stronę główną.' },
      en: { title: 'You do not have access here', lead: 'Your account lacks permission for this resource. If that looks wrong, head back to the homepage.' }
    },
    404: {
      slug: 'NOT_FOUND',
      pl: { title: 'Tej strony tu nie ma', lead: 'Link jest nieaktualny albo w adresie wkradła się literówka. Nic się nie stało — poniżej są dwa miejsca, w których na pewno coś jest.' },
      en: { title: 'This page does not exist', lead: 'The link is out of date, or the address has a typo in it. No harm done — below are two places that definitely do exist.' }
    },
    405: {
      slug: 'METHOD_NOT_ALLOWED',
      pl: { title: 'Ta metoda tu nie działa', lead: 'Zasób istnieje, ale nie obsługuje tego typu żądania.' },
      en: { title: 'That method is not allowed here', lead: 'The resource exists but does not accept this kind of request.' }
    },
    408: {
      slug: 'REQUEST_TIMEOUT',
      pl: { title: 'Żądanie trwało za długo', lead: 'Połączenie wygasło, zanim serwer zdążył odpowiedzieć. Sprawdź sieć i spróbuj ponownie.' },
      en: { title: 'The request took too long', lead: 'The connection expired before the server answered. Check your network and try again.' }
    },
    410: {
      slug: 'GONE',
      pl: { title: 'Ta strona została usunięta', lead: 'Zasób istniał kiedyś, ale został trwale usunięty i nie wróci pod tym adresem.' },
      en: { title: 'This page is gone', lead: 'The resource used to exist but has been permanently removed, and it is not coming back at this address.' }
    },
    429: {
      slug: 'TOO_MANY_REQUESTS',
      pl: { title: 'Za dużo żądań naraz', lead: 'Przekroczono limit zapytań. Odczekaj chwilę i spróbuj ponownie — to ograniczenie jest tymczasowe.' },
      en: { title: 'Too many requests', lead: 'You have hit the rate limit. Wait a moment and try again — this is temporary.' }
    },
    500: {
      slug: 'INTERNAL_SERVER_ERROR',
      pl: { title: 'Coś poszło nie tak po naszej stronie', lead: 'To nasz błąd, nie Twój. Odśwież stronę za chwilę — jeśli problem wróci, daj nam znać.' },
      en: { title: 'Something broke on our side', lead: 'This one is on us, not you. Refresh in a moment — if it keeps happening, let us know.' }
    },
    502: {
      slug: 'BAD_GATEWAY',
      pl: { title: 'Serwer odpowiedział błędem', lead: 'Usługa, z której korzysta ta strona, zwróciła nieprawidłową odpowiedź. Spróbuj ponownie za chwilę.' },
      en: { title: 'The server answered with an error', lead: 'A service this page depends on returned an invalid response. Try again shortly.' }
    },
    503: {
      slug: 'SERVICE_UNAVAILABLE',
      pl: { title: 'Chwilowo niedostępne', lead: 'Prowadzimy prace nad serwisem. Aplikacja działa normalnie — wróć tu za jakiś czas.' },
      en: { title: 'Temporarily unavailable', lead: 'The site is under maintenance. The app keeps running as usual — check back a bit later.' }
    },
    504: {
      slug: 'GATEWAY_TIMEOUT',
      pl: { title: 'Serwer nie odpowiedział na czas', lead: 'Usługa w tle nie zdążyła odpowiedzieć. To zwykle chwilowe — spróbuj ponownie.' },
      en: { title: 'The server timed out', lead: 'A background service did not answer in time. This is usually brief — try again.' }
    }
  };

  var FALLBACK = {
    slug: 'ERROR',
    pl: { title: 'Coś poszło nie tak', lead: 'Napotkaliśmy nieoczekiwany problem. Wróć na stronę główną albo otwórz aplikację.' },
    en: { title: 'Something went wrong', lead: 'We hit an unexpected problem. Head back to the homepage, or open the app.' }
  };

  function pickLang() {
    var saved = null;
    try {
      saved = localStorage.getItem('plately_landing_lang');
    } catch (e) {}
    var code = (saved || navigator.language || 'pl').slice(0, 2).toLowerCase();
    return code === 'pl' ? 'pl' : 'en';
  }

  function pickCode() {
    var fromQuery = new URLSearchParams(window.location.search).get('code');
    var fromBody = document.body.getAttribute('data-code');
    var raw = parseInt(fromQuery || fromBody || '', 10);
    return CODES[raw] ? raw : raw >= 400 && raw <= 599 ? raw : 500;
  }

  var lang = pickLang();
  var code = pickCode();
  var entry = CODES[code] || FALLBACK;
  var strings = Object.assign({}, COMMON[lang], entry[lang] || FALLBACK[lang]);

  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var value = strings[el.getAttribute('data-i18n')];
    if (typeof value === 'string') el.textContent = value;
  });

  var codeEl = document.querySelector('.pl-code');
  if (codeEl) codeEl.textContent = String(code);

  var monoEl = document.querySelector('.pl-mono');
  if (monoEl) monoEl.textContent = code + ' · ' + entry.slug;

  document.title = code + ' — ' + strings.title + ' · Plately';
})();
