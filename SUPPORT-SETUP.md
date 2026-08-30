# Plately Support — uruchomienie krok po kroku

Panel supportu żyje pod `https://plately.eu/support` (stary adres `/admin` przekierowuje
tam na stałe). Logowanie ma teraz **trzy kroki**: **Google → 6-cyfrowy kod z aplikacji
uwierzytelniającej → 4-cyfrowy PIN**, z **Cloudflare Turnstile** przed dwoma ostatnimi.

Dwa pierwsze kroki dzieją się na tej samej stronie logowania — po Google przycisk zamienia
się w pole na kod, a u góry pojawia się, kim jesteś i że jesteś w połowie zalogowany. PIN
jest ostatni i pytamy o niego już nad samym biurkiem, bo to moment, w którym drzwi
faktycznie się otwierają. Panel
maintenance (włączanie/wyłączanie strony) nie zniknął — jest kartą **Site control**
w zakładce *Settings*, widoczną wyłącznie dla ról `owner` i `admin`.

Klienci piszą do nas przez **`https://plately.eu/help`** — publiczny formularz, który
zakłada ticket i od razu wysyła potwierdzenie z `contact@plately.eu`.

Wszystko poniżej mieści się w darmowych planach: Supabase (ten sam projekt co aplikacja),
Vercel Hobby, Cloudflare Turnstile, Resend (3 000 maili/mies., 100/dzień — wspólna pula dla
odbioru i wysyłki). Drugi składnik to standard TOTP (RFC 6238) — nie ma tu żadnej usługi
zewnętrznej ani opłaty: sekret i kod QR generuje nasza własna funkcja, a po drugiej stronie
działa dowolna darmowa aplikacja (Google Authenticator, Aegis, 1Password, Bitwarden).

Kolejność ma znaczenie. Kroki 1–6 uruchamiają panel, 7–8 podpinają pocztę, 9 włącza
publiczną stronę pomocy.

---

## Co dokładnie doszło do repo

```
Showcase WEB/
  supabase/support-schema.sql      ← cały schemat: tabele, role, funkcje. Uruchamiasz raz.
  api/_lib/db.js                   ← rozmowa z Supabase (PostgREST, klucz service role)
  api/_lib/mail.js                 ← Resend: wysyłka, odbiór, podpisy webhooków
  api/_lib/staff-session.js        ← ciasteczka sesji, hash PIN-u, Turnstile, uprawnienia
  api/_lib/totp.js                 ← TOTP (RFC 6238) + własny generator kodów QR
  api/staff/[...path].js           ← Google, PIN, aplikacja uwierzytelniająca, zespół
  api/support/[...path].js         ← tickety, wiadomości, raporty, KB, webhook poczty
  api/help/[...path].js            ← publiczny formularz pomocy (bez sesji)
  public/support/index.html        ← panel, przeniesiony z /admin
  public/support/app.js
  public/support/support.css
  public/support/legacy.html       ← stary panel maintenance, jako wyjście awaryjne
  public/help.html                 ← strona pomocy dla klientów (PL/EN, jeden plik)
  .env.example                     ← opis każdej zmiennej środowiskowej
  vercel.json                      ← przekierowanie /admin → /support, CSP dla obu stron

Application APK/
  src/lib/staff.ts                 ← useStaff() / can() — te same role w aplikacji
```

Trzy pliki API zamiast kilkudziesięciu, bo **Vercel Hobby dopuszcza 12 funkcji na
deployment**. Routing siedzi w środku każdego pliku.

`api/_lib/totp.js` nie ma zależności i nie odpytuje niczego na zewnątrz — również kod QR
rysuje sam. To nie jest ozdoba: w tym kodzie QR siedzi żywy sekret drugiego składnika,
a wysyłanie go do cudzego generatora obrazków byłoby oddaniem tego sekretu obcemu
serwerowi. CSP panelu i tak zabroniłoby wczytania takiego obrazka.

---

## 1. Baza danych (Supabase)

Ten sam projekt, którego używa aplikacja — dzięki temu w tickecie widać realny plan
i faktury osoby, która napisała.

1. [supabase.com](https://supabase.com) → Twój projekt → **SQL Editor** → **New query**.
2. Wklej całą zawartość `Showcase WEB/supabase/support-schema.sql` → **Run**.
   Skrypt jest idempotentny, można go puścić ponownie po każdej aktualizacji.
3. Na samym dole pliku jest zakomentowany blok „First owner". Odkomentuj go
   (albo wklej osobno) **ze swoim adresem Google**:

   ```sql
   insert into public.staff (email, display_name, role, tier)
   values ('twoj.adres@gmail.com', 'Jacek', 'owner', 3)
   on conflict (lower(email)) do update set role = 'owner', tier = 3, active = true;
   ```

   To jest cała „rejestracja". Bez wiersza w `staff` żaden adres Google się nie zaloguje —
   panel nie zakłada kont sam z siebie.
4. Teraz dwie wartości do kroku 4. Supabase rozbił je na **dwa różne ekrany**, co jest
   najczęstszym punktem zgubienia się:

   **`SUPABASE_URL`** — nie ma go na stronie z kluczami. Masz trzy drogi, wszystkie dają
   to samo:
   - zielony przycisk **Connect** na górze dashboardu → sekcja *App Frameworks* → pozycja
     `Project URL`,
   - **Project Settings → Data API** (adres kończy się na `/settings/api`) → `Project URL`,
   - albo po prostu przepisz z adresu swojej przeglądarki: identyfikator projektu widoczny
     w URL-u dashboardu (`.../project/TU-JEST-REF/...`) daje
     **`https://TU-JEST-REF.supabase.co`**. To jest cały Project URL — nic więcej się w nim
     nie ukrywa.

   **`SUPABASE_SERVICE_ROLE_KEY`** — to jest ta strona, na którą patrzysz
   (**Project Settings → API Keys**). Zależnie od wieku projektu zobaczysz jedno z dwóch:
   - zakładka **Legacy API Keys** → klucz **`service_role`** (długi, zaczyna się od `eyJ`), albo
   - sekcja **Secret keys** → klucz **`sb_secret_…`**.

   **Oba działają** — kod rozpoznaje, który dostał, i wysyła go tak, jak trzeba (nowe klucze
   nie są JWT i muszą lecieć innym nagłówkiem niż stare; to już obsłużone).
   Nie bierz `anon` ani `publishable` — te są publiczne i nic nie odblokują.

> Klucz serwerowy omija Row Level Security. Trafia wyłącznie do zmiennych w Vercelu i nigdy
> do przeglądarki — dlatego cała komunikacja panelu z bazą idzie przez `/api/*`.

---

## 2. Logowanie Google

Nazwy poniżej są takie, jak w **polskiej** wersji konsoli. Google ma teraz dwa układy —
nowszy („Platforma Google Auth") i klasyczny; opisuję nowszy, a w nawiasach podaję, gdzie
to samo leży w starym. Angielskie odpowiedniki dopisuję kursywą, bo część kont ma konsolę
częściowo nieprzetłumaczoną.

1. [console.cloud.google.com](https://console.cloud.google.com) → u góry wybierz projekt
   (może być ten sam, którego używa logowanie w aplikacji).

2. Menu boczne → **Platforma Google Auth** *(Google Auth Platform)*.
   W starym układzie: **Interfejsy API i usługi → Ekran zgody OAuth**
   *(APIs & Services → OAuth consent screen)*.

   Jeśli w tym projekcie nic jeszcze nie było konfigurowane, konsola poprowadzi Cię
   kreatorem — wypełnij:
   - **Nazwa aplikacji** *(App name)*: `Plately Support`
   - **Adres e-mail pomocy dla użytkowników** *(User support email)*: Twój adres
   - **Odbiorcy** *(Audience)* / **Typ użytkownika**: **Zewnętrzny** *(External)*
   - **Dane kontaktowe dewelopera** *(Developer contact information)*: Twój adres
   - Zapisz (**Utwórz** / **Zapisz i kontynuuj**)

3. **Odbiorcy** *(Audience)* — zostaw **Stan publikacji: Testowanie** *(Testing)* i w sekcji
   **Użytkownicy testowi** *(Test users)* dodaj adresy Google wszystkich agentów.

   Dla wewnętrznego panelu to w zupełności wystarcza i **nie wymaga weryfikacji przez
   Google**. Ograniczenie trybu testowego — wygasanie tokenów odświeżania po 7 dniach — nas
   nie dotyczy, bo przy logowaniu używamy wyłącznie jednorazowego `id_token`.

   Alternatywnie możesz kliknąć **Opublikuj aplikację** *(Publish app)*: przy samych
   zakresach `openid`, `email` i `profile` Google też nie żąda weryfikacji, a znika limit
   listy użytkowników testowych.

4. **Klienci** *(Clients)* → **Utwórz klienta** *(Create client)*.
   W starym układzie: **Dane logowania → Utwórz dane logowania → Identyfikator klienta
   OAuth** *(Credentials → Create credentials → OAuth client ID)*.

   - **Typ aplikacji** *(Application type)*: **Aplikacja internetowa** *(Web application)*
   - **Nazwa** *(Name)*: `plately-admin` (widoczna tylko dla Ciebie)

5. **Autoryzowane identyfikatory URI przekierowania** *(Authorised redirect URIs)* →
   **Dodaj identyfikator URI**, i wpisz **wszystkie cztery**, każdy osobno:

   ```
   https://www.plately.eu/api/staff/callback
   https://plately.eu/api/staff/callback
   https://www.plately.eu/api/help/callback
   https://plately.eu/api/help/callback
   ```

   Dwa pierwsze to logowanie zespołu do panelu. Dwa kolejne obsługują przycisk
   „Podłącz adres z Google" na stronie `/help`: klient nie zakłada tam żadnego konta —
   pobieramy wyłącznie jego adres, żeby ticket miał adres potwierdzony przez Google,
   a nie tylko wpisany z klawiatury.

   Muszą zgadzać się co do znaku — bez ukośnika na końcu, `https`, dokładnie ta ścieżka.
   Wejście z hosta, którego tu nie ma, kończy się błędem `redirect_uri_mismatch`.

   Pole **Autoryzowane źródła JavaScriptu** *(Authorised JavaScript origins)* zostaw
   **puste**. Nasz przepływ jest w całości server-side — przeglądarka nigdy nie dotyka
   API Google bezpośrednio, więc to pole nie jest do niczego potrzebne.

6. **Utwórz**. Google pokaże **Identyfikator klienta** *(Client ID)* i **Tajny klucz
   klienta** *(Client secret)* — to są `GOOGLE_CLIENT_ID` i `GOOGLE_CLIENT_SECRET` z kroku 4.
   Tajny klucz można później podejrzeć ponownie na karcie klienta, ale wygodniej skopiować
   od razu.

> Pozostałe panele (Supabase, Vercel, Cloudflare, Resend, Spaceship) nie mają polskiej
> wersji — tam nazwy w tym przewodniku są angielskie, bo takie zobaczysz na ekranie.

---

## 3. Turnstile (blokada botów)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Turnstile** → **Add widget**.
2. Nazwa: `plately-admin`. Hostnames: `plately.eu` **i** `www.plately.eu`.
3. Widget mode: **Managed** (Cloudflare sam decyduje, czy pokazać wyzwanie).
4. Zapisz **Site Key** i **Secret Key**.

Ten sam widget obsługuje dwa miejsca — to ten sam host, więc jeden wpis wystarcza:

- w panelu stoi przed **kodem z aplikacji i przed PIN-em**; bez tokenu request nie
  przechodzi. Sam przycisk Google nie jest bramkowany: oddaje ruch do Google, które ma
  własną ochronę przed botami, a niedokończona sesja nie otwiera żadnego endpointu;
- na `/help` jest tym, co powstrzymuje zalanie biurka ticketami z jednego skryptu.

Brak kluczy nie psuje żadnej z tych stron — wyzwanie jest wtedy pomijane. W panelu zostają
Google, PIN i aplikacja uwierzytelniająca, a formularz pomocy ma jeszcze limit 5 zgłoszeń
na godzinę z jednego adresu, liczony w bazie.

---

## 4. Sekrety i zmienne w Vercelu

**Najpierw spójrz na listę, która już tam jest.** `SESSION_SECRET` i `PEPPER` na 99%
istnieją — używa ich dzisiejszy panel maintenance. Vercel nie pozwoli dodać drugiej
zmiennej o tej samej nazwie („A variable with the name … already exists"), i bardzo dobrze:

- `SESSION_SECRET` — zostaw istniejący. Nowy panel podpisze nim swoje ciasteczka tak samo.
- `PEPPER` — **zostaw istniejący, nie podmieniaj.** Na nim policzony jest
  `ADMIN_PASSWORD_HASH` do `/support/legacy`; nowa wartość zabija to wejście awaryjne.
  (Gdybyś kiedyś musiał go zmienić: wygeneruj nowy hash hasła tym samym pepperem —
  polecenie jest w `.env.example` — i zresetuj wszystkie PIN-y.)

Generujesz je tylko wtedy, gdy ich nie ma. Dwa **różne** losowe ciągi, dwa wywołania:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Zmianę istniejącej wartości robi się przez **⋯ → Edit** na wierszu, nie przez dodanie nowej.

Vercel → projekt `plately` → **Settings → Environment Variables**. Dodaj dla środowiska
**Production** (i Preview, jeśli używasz) to, czego brakuje:

| Zmienna | Wartość |
| --- | --- |
| `SUPABASE_URL` | `https://<ref-projektu>.supabase.co` (krok 1.4) |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` **albo** `sb_secret_…` (krok 1.4) |
| `GOOGLE_CLIENT_ID` | z kroku 2 |
| `GOOGLE_CLIENT_SECRET` | z kroku 2 |
| `SESSION_SECRET` | **zwykle już istnieje** — zostaw. Inaczej: pierwszy wygenerowany ciąg |
| `PEPPER` | **zwykle już istnieje** — zostaw. Inaczej: drugi wygenerowany ciąg |
| `TURNSTILE_SITE_KEY` | z kroku 3 |
| `TURNSTILE_SECRET_KEY` | z kroku 3 |
| `SUPPORT_MAIL_DOMAIN` | `plately.eu` |
| `SUPPORT_FROM_EMAIL` | `contact@plately.eu` |
| `SUPPORT_FROM_NAME` | `Plately Support` |

`RESEND_*` dodasz w krokach 7–8. `GLOBAL_CONFIG`, `VERCEL_API_TOKEN`, `ADMIN_*` już tam są —
nie ruszaj ich.

> **`PEPPER` jest tym, co chroni 4-cyfrowy PIN.** Hash PIN-u w bazie jest liczony z pepperem,
> którego w bazie nie ma. Sam zrzut tabeli `staff` nie wystarczy, żeby przelecieć 10 000
> kombinacji. Zmiana `PEPPER` unieważnia wszystkie PIN-y; zmiana `SESSION_SECRET` wylogowuje
> wszystkich.

---

## 5. Deploy

Wypchnij zmiany do repo (`KrzyszofWPL/dasdvwes-app`, branch `main`) — Vercel zbuduje sam.
Jeśli dodałeś zmienne po ostatnim deployu: **Deployments → ⋯ → Redeploy**. Vercel podaje
nowe wartości tylko nowym deploymentom.

### Sprawdź jedną komendą, czego brakuje

```bash
curl -s https://plately.eu/api/staff/health
```

To jest pierwsza rzecz, po którą sięgasz, gdy coś nie działa. Odpowiada **bez logowania**
— bo moment, w którym tego potrzebujesz, to dokładnie moment, w którym nikt nie może
wejść. Zwraca same wartości `true`/`false` i nazwy zmiennych, nigdy ich wartości.

Szukasz dwóch pól:

```json
{ "signInWorks": true, "blocking": [] }
```

Jeśli `signInWorks` jest `false`, w `blocking` masz gotową listę rzeczy do zrobienia —
np. `"run supabase/support-schema.sql"` albo `"GOOGLE_CLIENT_SECRET is not set"`.
`database.schema` mówi `current` albo `out of date`, a `database.staffRows` pokazuje,
czy ktokolwiek jest w ogóle na liście zespołu.

Osobno, bo to nie blokuje logowania: `mailWorks`, `inboundMailWorks`, `botCheckActive`.

Test samego endpointu sesji:

```bash
curl -s https://plately.eu/api/staff/session
```

Oczekiwane: `{"state":"signed_out","turnstileSiteKey":"0x4AAA…","googleConfigured":true}`.
Jeśli widzisz `googleConfigured: false` — zmienne nie doszły, zrób redeploy.

To samo dla publicznej strony pomocy:

```bash
curl -s https://plately.eu/api/help/session
```

Oczekiwane: `{"email":null,…,"googleConfigured":true,"mailConfigured":true}`.
`mailConfigured: false` oznacza brak `RESEND_API_KEY` — formularz powie o tym wprost
i nie przyjmie wiadomości, której nie umiałby potwierdzić.

I że stary adres panelu przekierowuje:

```bash
curl -sI https://plately.eu/admin | head -3
```

Oczekiwane: `HTTP/2 308` i `location: /support`.

---

## 6. Pierwsze logowanie

**Przygotuj telefon.** Będzie potrzebna aplikacja uwierzytelniająca — wystarczy dowolna
darmowa: Google Authenticator, Aegis, 2FAS, albo menedżer haseł, którego już używasz
(1Password, Bitwarden). Nie zakładasz nigdzie konta i nic nie płacisz.

1. Wejdź na `https://plately.eu/support`.
2. **Continue with Google** → wybierz adres z kroku 1.
3. Wracasz na tę samą stronę, ale zamiast przycisku Google jest teraz **kod QR**, a u góry
   widać Twój awatar, adres i plakietkę *Half signed in*. Zeskanuj kod aplikacją z telefonu
   i przepisz sześć cyfr, które się pojawią. Jeśli kamera nie działa, kliknij
   *Can't scan? Show the key instead* i wpisz klucz ręcznie — to dokładnie ten sam sekret.
4. Pokazuje się biurko za szybą i napis **One last step**: ustaw **PIN**, cztery cyfry,
   dwa razy. Odrzuci `0000`, `1234` i kilka innych oczywistych.
5. Jesteś w środku. Inbox będzie pusty do kroku 8.

Od tej pory każde logowanie to Google → kod z aplikacji → PIN. Sesja trwa 12 godzin.

Kod jest ważny 30 sekund (plus jedno okno w każdą stronę, na wypadek rozjechanego zegara
w telefonie) i **działa dokładnie raz** — panel zapamiętuje przyjęty przedział, więc kod
podejrzany komuś przez ramię nie da się użyć drugi raz.

**Zablokowanie się jest odwracalne** — patrz sekcja „Kiedy coś pójdzie nie tak".

---

## 7. Poczta: wysyłka z contact@plately.eu

> **Ten krok wystarcza, żeby formularz `/help` działał od początku do końca.** Klient
> zgłasza problem → ticket od razu jest w panelu → klient dostaje potwierdzenie
> z `contact@plately.eu`. Formularz zapisuje zgłoszenie **prosto do bazy**, nie mailem,
> więc do samego zobaczenia go w help desku poczta przychodząca nie jest potrzebna.
>
> Krok 8 dokłada dwie rzeczy, których bez niego nie ma: **odpowiedź klienta wraca na ten
> sam ticket** (bez tego rozmowa jest jednokierunkowa), oraz **mail wysłany wprost na
> `contact@plately.eu`, z pominięciem formularza, też zakłada ticket**.
>
> Krok 7 niczego nie psuje. Krok 8 przekierowuje całą pocztę `@plately.eu` — przeczytaj
> ostrzeżenie na jego początku, zanim go zrobisz.

DNS plately.eu jest na **Spaceship** (`launch1/launch2.spaceship.net`) i tam zostaje.
Rekordy do wysyłki lądują na subdomenie `send.` — **apex zostaje nietknięty**, więc ten krok
niczego jeszcze nie psuje.

Stan wyjściowy Twojej domeny (sprawdzone): MX na apeksie to `mx1/mx2.efwd.spaceship.net`
(darmowe forwardowanie Spaceship), a SPF to `v=spf1 include:spf.efwd.spaceship.net ~all`.
Na `send.plately.eu` nie ma jeszcze nic. Po kroku 7 apex zostaje dokładnie taki, jaki jest.

1. Załóż darmowe konto na [resend.com](https://resend.com).
2. **Domains → Add Domain** → `plately.eu`. Region wybierz europejski, jeśli jest dostępny.
3. Resend pokaże 3 rekordy. Wejdź na Spaceship → **Domains → plately.eu → Advanced DNS**
   i dodaj je dokładnie tak, jak są pokazane (Resend podaje wartości; poniżej kształt):

   | Typ | Host | Wartość | Priorytet |
   | --- | --- | --- | --- |
   | MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (Resend pokaże swoją) | 10 |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
   | TXT | `resend._domainkey` | `p=MIGfMA0…` (długi klucz z Resend) | — |

   **Wpisuj sam host, bez domeny** — `send`, nie `send.plately.eu`. Spaceship dokleja domenę sam.

   Istniejącego SPF na apeksie (`v=spf1 include:spf.efwd.spaceship.net ~all`) **nie ruszaj** —
   SPF Resenda siedzi na `send`, to dwa różne rekordy. (Gdyby kiedykolwiek trzeba było mieć
   dwa include'y na apeksie, muszą wylądować w **jednym** rekordzie TXT — dwa rekordy SPF to
   błąd konfiguracji.)

4. Wróć do Resend → **Verify**. Propagacja to zwykle kilka minut, czasem godzina.
5. **API Keys → Create API Key**, uprawnienia **Full access** (panel i wysyła, i czyta
   przychodzące). Skopiuj — pokazuje się raz.
6. Vercel → dodaj `RESEND_API_KEY` → **Redeploy**.

Test 1 — panel wysyła: **New ticket** → wpisz swój prywatny adres, temat i treść →
*Create and send*. Mail powinien dojść z `Plately Support <contact@plately.eu>`, a w panelu
pojawia się ticket `SUP-1000`.

Test 2 — formularz działa: wejdź na `https://plately.eu/help`, wyślij zgłoszenie na swój
adres. Ma się wydarzyć jedno i drugie naraz: numer `SUP-…` na stronie i potwierdzenie
w skrzynce, a w panelu nowy ticket z kanałem `form`.

Szybkie sprawdzenie, że klucz doszedł:

```bash
curl -s https://plately.eu/api/staff/health
```

`"mailWorks": true` oznacza, że `RESEND_API_KEY` jest na miejscu.

---

## 8. Poczta: odbiór na contact@plately.eu

> ⚠️ **Ten krok wyłącza dotychczasowe przekierowanie ze Spaceship.** Sprawdziłem: apex ma
> teraz `MX → mx1.efwd.spaceship.net` i `mx2.efwd.spaceship.net` (priorytet 0), czyli
> darmowe forwardowanie Spaceship — to jest to, co dziś przenosi pocztę z `contact@` na
> Twojego Gmaila. Po podmianie na MX Resenda **każdy** adres `@plately.eu` (contact@,
> hello@, cokolwiek) trafia do Resenda, a nie na Gmaila. To jest właśnie cel — panel staje
> się skrzynką — ale warto wiedzieć zawczasu, i warto zrobić to wtedy, gdy masz chwilę
> sprawdzić efekt, a nie w piątek wieczorem.
>
> Jeśli chcesz na jakiś czas dostawać też kopię na Gmaila: ustaw w Vercelu
> `SUPPORT_FORWARD_COPY_TO="twoj@gmail.com"`. Webhook prześle wtedy kopię każdej
> przychodzącej wiadomości (kosztuje 1 mail z dziennego limitu 100). Usuniesz zmienną, gdy
> przestanie być potrzebna.

1. Resend → **Domains → plately.eu → Inbound** (albo *Receiving*) → włącz odbiór.
2. Resend pokaże **rekord MX dla odbioru**. Na Spaceship → **Advanced DNS**:
   - **usuń** dwa istniejące rekordy MX `mx1.efwd.spaceship.net` i `mx2.efwd.spaceship.net`,
   - **dodaj** MX z hostem `@` i wartością/priorytetem podanym przez Resend.
3. Sprawdź propagację:
   ```bash
   nslookup -type=MX plately.eu 8.8.8.8
   ```
   Ma pokazać host Resenda, nie `efwd.spaceship.net`.
4. Resend → **Webhooks → Add Webhook**:
   - **Endpoint URL**: `https://plately.eu/api/support/inbound`
   - **Event**: `email.received`
   - Zapisz i skopiuj **Signing Secret** (`whsec_…`).
5. Vercel → `RESEND_WEBHOOK_SECRET` = ten sekret → **Redeploy**.

   Bez tej zmiennej endpoint **odrzuca wszystko** (401) — celowo: to jedyna trasa bez sesji,
   która potrafi założyć ticket i wysłać maila.

Sprawdzenie, że oba sekrety doszły:

```bash
curl -s https://plately.eu/api/staff/health
```

Szukasz `"inboundMailWorks": true`.

Test: z prywatnej skrzynki napisz na `contact@plately.eu`. W ciągu kilkunastu sekund
w Inboxie pojawia się nowy ticket, a nadawca dostaje automatyczne potwierdzenie
(z numerem `SUP-…`, treść edytujesz w *Settings → E-mail channel*).

Jeśli nic nie przychodzi, kolejność sprawdzania jest zawsze ta sama: czy `nslookup` pokazuje
już MX Resenda (propagacja bywa godzinna), potem Resend → **Webhooks → Attempts** — tam widać
każdą próbę i kod odpowiedzi. `401` to zły albo brakujący `RESEND_WEBHOOK_SECRET`; cisza
oznacza, że mail w ogóle nie doszedł do Resenda, czyli MX jeszcze nie zadziałał.

Test wątkowania: odpowiedz z panelu, potem odpisz ze swojej skrzynki na tę odpowiedź.
Powinno dokleić się do **tego samego** ticketu, a nie założyć nowy.

---

## 9. Strona pomocy dla klientów — `/help`

Nie wymaga niczego poza tym, co już ustawiłeś: używa tego samego klucza Resend, tego
samego widgetu Turnstile i tego samego klienta OAuth. Po deployu po prostu działa.
Sprawdź, że jest tam wszystko, czego oczekujesz:

1. Wejdź na `https://plately.eu/help`. Strona przełącza się polski/angielski i sama
   zgaduje język przeglądarki.
2. Wypełnij formularz swoim prywatnym adresem i wyślij.
3. Powinno się wydarzyć trzy rzeczy naraz:
   - na stronie pojawia się numer zgłoszenia (`SUP-…`),
   - na Twój adres przychodzi potwierdzenie **od `Plately Support <contact@plately.eu>`**,
   - w panelu `/support` ląduje nowy ticket z kanałem `form` i kategorią, którą wybrałeś.
4. Odpowiedz na to potwierdzenie ze swojej skrzynki — musi dokleić się do **tego samego**
   ticketu, a nie założyć nowy. (Numer `[SUP-…]` w temacie jest tym, co je łączy.)

**Kategorie** z formularza to dokładnie te same tagi, których używa panel (`Billing`,
`Bug`, `Feature request`, `How-to`, `Account`, `Other`), więc zgłoszenie od razu wpada do
właściwej kolejki na pasku bocznym.

**Przycisk „Podłącz adres z Google"** jest opcjonalny i daje jedną konkretną rzecz: adres
na tickecie jest wtedy potwierdzony przez Google, a nie wpisany z klawiatury. W zdarzeniu
`ticket.created_form` zapisuje się `email_verified: true` — przy „nie mogę się dostać do
swojego konta" to różnica między sprawą do załatwienia a prośbą o uwierzenie obcej osobie
na słowo.

**Limit:** 5 zgłoszeń na godzinę z jednego adresu e-mail albo z jednego adresu IP.
IP nie jest zapisywane — trafia do bazy jako skrót HMAC liczony `PEPPER`-em, którego
w bazie nie ma. Limit liczy sama funkcja `support_ingest_form`, w tej samej transakcji
co wstawienie ticketu, więc nie da się go wyścigać równoległymi żądaniami.

Strona jest też **dostępna podczas przerwy technicznej**. To celowe: moment, w którym
strona jest wyłączona, to dokładnie ten moment, w którym ludzie chcą zapytać, co się
dzieje — zamykanie im wtedy jedynych drzwi nie miałoby sensu.

---

## 10. Jak to jest poskładane (żeby dało się to potem debugować)

**Logowanie.** `POST /api/staff/start` zwraca URL Google, zapisując
`state` + `nonce` w podpisanym ciasteczku. `GET /api/staff/callback` wymienia kod na
`id_token`, sprawdza `aud`/`iss`/`nonce`, szuka adresu w `staff` i wydaje **pół-sesję** —
dowód Google i nic więcej. `POST /api/staff/totp` (kod + Turnstile) **nie wydaje sesji**:
odnawia pół-sesję ze znacznikiem `tp`, że kod jest już za nami. Dopiero
`POST /api/staff/pin` (PIN + Turnstile) wydaje właściwe ciasteczko sesji na 12 godzin.
Konto Google jest przypinane przy pierwszym logowaniu (`google_sub`): ten sam adres
z innego konta Google to inna osoba i dostaje odmowę.

Kolejność jest taka, a nie odwrotna, z dwóch powodów. Kod z aplikacji jest tym, co
najtrudniej podrobić, więc odsiewa najwcześniej — nikt nie dochodzi do pytania o PIN,
nie mając telefonu. A PIN, jako jedyna rzecz trzymana wyłącznie w głowie, wypada jako
ostatnie kliknięcie przed otwarciem biurka.

Każdy krok odmawia działania, jeśli poprzedni nie zostawił po sobie śladu w pół-sesji —
dlatego kolejności nie da się ominąć, wołając endpointy bezpośrednio. To jest jedyny
powód, dla którego trzystopniowe logowanie jest warte więcej niż jednostopniowe.

**PIN.** PBKDF2-SHA256, sól per osoba w bazie + `PEPPER` ze zmiennej. Pięć błędnych prób
= 15 minut blokady. PIN-u nie da się „zresetować sobie samemu" — robi to owner
(*Settings → Team and roles → Edit → Reset PIN*).

**Aplikacja uwierzytelniająca.** Drugi krok, zaraz po Google. Standardowy TOTP:
HMAC-SHA1 z 20-bajtowego sekretu i licznika 30-sekundowego, sześć cyfr. Sekret jest zapisywany od razu, ale `totp_enrolled_at`
zostaje puste do chwili, gdy pierwszy kod się zgodzi — dzięki temu zeskanowanie kodu i
zamknięcie karty nikogo nie zamyka na zewnątrz, a ponowne wejście po prostu pokazuje ten
sam kod jeszcze raz. Przyjęty przedział czasu ląduje w `totp_last_step`, co sprawia, że
każdy kod działa **dokładnie raz**. Pięć błędnych prób = te same 15 minut blokady.

Sekret TOTP jest jedyną wartością w tej bazie, która **nie jest** zahaszowana — i nie
może być, bo weryfikacja kodu wymaga samego sekretu. Traktuj wyciek tej kolumny jak wyciek
`PEPPER`-a: zresetuj aplikacje wszystkim agentom.

**Zmiana telefonu.** *Settings → New phone*. Wymaga podania aktualnego PIN-u, mimo że
sesja jest już zalogowana — bo aplikacja uwierzytelniająca istnieje właśnie po to, żeby
przetrwać przejęcie sesji, więc pozwolenie samej sesji na jej odpięcie znosiłoby cały sens.
Stary telefon przestaje działać natychmiast, a nowy potwierdza się jednym kodem od razu
w oknie, a nie dopiero przy następnym logowaniu.

**Zgubiony telefon.** Owner odpina aplikację w *Settings → Team and roles → Edit →
Unlink authenticator*; agent podłącza nową przy kolejnym logowaniu. Nowy sekret nigdy nie
przechodzi przez ręce ownera — powstaje dopiero w przeglądarce tej osoby, która go użyje.

**Formularz `/help`.** Osobna funkcja (`api/help/[...path].js`), a nie kolejna gałąź
`/api/support`, bo granica zaufania jest tam odwrotna: w `/api/support` wszystko wymaga
sesji zespołu, a tutaj wszystko jest dostępne dla każdego z internetu. Trzymanie obu
w jednym pliku oznaczałoby, że jedna zapomniana bramka zamienia formularz kontaktowy
w nieuwierzytelniony odczyt bazy ticketów.

**Poczta przychodząca.** Webhook Resenda niesie tylko metadane, więc treść dociągamy z
`GET /emails/receiving/{id}`. Dopasowanie do wątku po kolei: `[SUP-1042]` w temacie →
`In-Reply-To`/`References` wskazujące na nasz `Message-ID` → ten sam nadawca + ten sam temat
w ciągu 14 dni. Odpowiedź na zamknięty ticket otwiera go z powrotem. Duplikaty webhooka są
odrzucane po `provider_id` (Resend ponawia, dopóki nie dostanie 2xx).

**Uprawnienia.** Definicja jest w trzech miejscach, bo działa w trzech runtime'ach:
`support_tier_allows()` w SQL, `can()` w `api/_lib/staff-session.js`, `can()` w
`Application APK/src/lib/staff.ts`. Zmieniasz jedno — zmień wszystkie trzy. Serwer i tak
sprawdza rolę na nowo przy każdym żądaniu, czytając wiersz z bazy, więc **odebranie
uprawnień działa natychmiast**, a nie po wygaśnięciu ciasteczka.

---

## 11. Role i tiery

| | owner | admin | agent T3 | agent T2 | agent T1 | viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Czytanie ticketów, klientów, raportów | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Odpowiedź, notatka, tag, priorytet, „solved" | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Przypisanie do siebie | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Eskalacja, zwrot, przypisanie komuś innemu | ✅ | ✅ | ✅ | ✅ | — | — |
| Otwarcie zamkniętego, spam, usunięcie ticketu | ✅ | ✅ | ✅ | — | — | — |
| Ustawienia biurka, baza wiedzy, **tryb maintenance** | ✅ | ✅ | — | — | — | — |
| Dodawanie ludzi, zmiana ról, reset PIN-u i aplikacji | ✅ | — | — | — | — | — |

Dodanie agenta: *Settings → Team and roles → Add agent*. Wpisujesz adres Google, rolę i tier —
i to cała „rejestracja": osoba wchodzi na `/support`, loguje się tym adresem, ustawia własny
PIN i podpina własną aplikację uwierzytelniającą. Nic nie jest wysyłane mailem, a Ty nigdy
nie widzisz ani jej PIN-u, ani jej sekretu TOTP.

Na liście zespołu przy każdej osobie widać, czego jeszcze nie ustawiła („PIN not set",
„no authenticator") — to wystarczy, żeby wiedzieć, kto naprawdę dokończył konfigurację.

W aplikacji te same role czyta `useStaff()` z `Application APK/src/lib/staff.ts`:

```tsx
const { staff, loading } = useStaff();
if (!loading && can(staff, 'maintenance')) {
  // np. skrót do panelu, podgląd diagnostyki, cokolwiek dla ekipy
}
```

Plik jest gotowy i nigdzie jeszcze nie podpięty — nie zmieniałem działających ekranów
aplikacji. Powiedz, gdzie ma się pojawić, to podepnę.

---

## 12. Kiedy coś pójdzie nie tak

**Nie mogę się zalogować / zgubiłem PIN albo telefon.**
Jeśli jest inny owner — zrobi to z panelu (*Settings → Team and roles → Edit → Reset PIN*
albo *Unlink authenticator*). Jeśli nie ma, Supabase → SQL Editor:

```sql
-- kasuje PIN I aplikację uwierzytelniającą; jedno i drugie ustawisz od nowa
-- przy następnym logowaniu
update public.staff
   set pin_hash = null, pin_salt = null, pin_set_at = null,
       totp_secret = null, totp_enrolled_at = null, totp_last_step = null,
       failed_pin_attempts = 0, failed_totp_attempts = 0, locked_until = null
 where lower(email) = 'twoj.adres@gmail.com';
```

Zostaw w tym `set` tylko te pola, które faktycznie chcesz skasować — jeśli zgubiłeś sam
telefon, nie ma powodu resetować przy okazji PIN-u.

**Aplikacja mówi, że kod jest zły, a jestem pewien, że przepisuję dobrze.**
Prawie zawsze to zegar w telefonie. TOTP liczy się z czasu, a nie z niczego innego:
włącz automatyczną synchronizację czasu w ustawieniach telefonu. Google Authenticator ma
też własne *Ustawienia → Korekta czasu dla kodów → Zsynchronizuj*. Panel akceptuje jedno
30-sekundowe okno w każdą stronę, więc rozjazd powyżej minuty jest już nie do przyjęcia.

**„That code is not right" tuż po udanym zalogowaniu.**
Każdy kod działa raz. Poczekaj, aż aplikacja pokaże następny.

**Google w ogóle nie działa, a muszę wyłączyć stronę.**
`https://plately.eu/support/legacy` — stary formularz login/hasło (`ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`), robi dokładnie to, co robił wcześniej, i nie przechodzi ani przez
PIN, ani przez aplikację uwierzytelniającą. Gdy nowe logowanie się sprawdzi, skasuj te
zmienne w Vercelu — strona przestanie działać i o to chodzi.

**„That Google account is not on the support team"** — brak wiersza w `staff` dla tego
adresu, albo `active = false`.

**`redirect_uri_mismatch`** — w Google Cloud (**Platforma Google Auth → Klienci →** Twój
klient **→ Autoryzowane identyfikatory URI przekierowania**) brakuje dokładnie tego adresu,
z którego wchodzisz. Najczęściej: dodany jest `www.plately.eu`, a wszedłeś na apex
`plately.eu` (albo odwrotnie). Mają tam być wszystkie cztery — dwa dla `/api/staff/callback`
i dwa dla `/api/help/callback` (krok 2.5). Jeśli błąd wyskakuje tylko przy przycisku na
`/help`, brakuje właśnie tej drugiej pary.

**Formularz `/help` odsyła „That is several messages in a short time".**
Limit 5/godzinę zadziałał. Przy testowaniu albo poczekaj, albo skasuj swoje zdarzenia:

```sql
delete from public.support_events
 where action = 'ticket.created_form' and actor = 'twoj.adres@gmail.com';
```

**Formularz przyjmuje wiadomość, ale potwierdzenie nie przychodzi.**
Ticket i tak powstaje — to celowe: lepiej mieć wiadomość bez potwierdzenia niż powiedzieć
komuś, że zgłoszenie przepadło, kiedy nie przepadło. Strona mówi wtedy wprost, że
potwierdzenie nie wyszło. Przyczyny szukaj tam, gdzie zwykle: Vercel → Deployments →
Functions → logi `api/help/[...path]`.

**Mail nie zakłada ticketu.** Po kolei: MX pokazuje Resenda (`nslookup -type=MX`)?
W Resend → Webhooks → Attempts widać próby i kod odpowiedzi? 401 = zły albo brakujący
`RESEND_WEBHOOK_SECRET`. Cisza = MX jeszcze się nie rozpropagował.

**Odpowiedź nie wychodzi.** Vercel → Deployments → Functions → logi
`api/support/[...path]`. Najczęściej: domena w Resend nie przeszła weryfikacji albo klucz
API nie ma *Full access*.

**„Something went wrong on our side" zaraz po zalogowaniu przez Google.**
Prawie zawsze jedno z dwóch: nie puściłeś jeszcze SQL-a (brakuje kolumn `totp_*` w tabeli
`staff`) albo nie ma zmiennych Supabase. Panel powie teraz które — komunikat nazywa
brakującą kolumnę albo brakującą zmienną. Jeśli nadal widzisz sam ogólnik, to znaczy, że
to nie jest problem konfiguracji: zajrzyj w Vercel → Deployments → Functions → logi
`api/staff/[...path]`.

```bash
curl -s https://plately.eu/api/staff/health
```

**Panel wygląda jak sprzed zmian.** `support.css` i `app.js` mają godzinny cache — podbij
`?v=` w `public/support/index.html`.

---

## 13. Limity, o których warto pamiętać

- **Resend free: 3 000 maili/miesiąc, 100/dzień**, i **odbiór liczy się do tej samej puli**.
  Jeden ticket to zwykle 1 (przychodzący) + 1 (auto-potwierdzenie) + 1 (odpowiedź) = 3 sztuki.
  W praktyce ~30 ticketów dziennie. Auto-potwierdzenie można wyłączyć w *Settings*.
- **Vercel Hobby: 12 funkcji na deployment.** Teraz jest 7 (4 stare `api/admin/*` +
  `staff`, `support`, `help`). Dokładając kolejne endpointy dopisuj trasy do istniejących
  plików `[...path].js` zamiast tworzyć nowe.
- **Supabase free**: 500 MB bazy. Tickety to tekst — starczy na bardzo długo.
- **Formularz `/help`: 5 zgłoszeń na godzinę** z adresu e-mail albo z adresu IP. Każde
  zgłoszenie to 1 mail (potwierdzenie) z dziennej puli 100.
- Sesja panelu: 12 godzin. Potem znowu Google + PIN + kod z aplikacji.
- Odświeżanie listy: co 30 sekund, tylko gdy karta jest widoczna i nie masz otwartego okna
  modalnego. Nigdy nie nadpisuje tego, co masz wpisane w polu odpowiedzi.
