# Plately Support — uruchomienie krok po kroku

Panel supportu żyje pod `https://plately.eu/admin`. Logowanie: **Google → 4-cyfrowy PIN**,
z **Cloudflare Turnstile** przed samym PIN-em. Panel maintenance (włączanie/wyłączanie
strony) nie zniknął — jest teraz kartą **Site control** w zakładce *Settings*, widoczną
wyłącznie dla ról `owner` i `admin`.

Wszystko poniżej mieści się w darmowych planach: Supabase (ten sam projekt co aplikacja),
Vercel Hobby, Cloudflare Turnstile, Resend (3 000 maili/mies., 100/dzień — wspólna pula dla
odbioru i wysyłki).

Kolejność ma znaczenie. Kroki 1–6 uruchamiają panel, 7–8 podpinają pocztę.

---

## Co dokładnie doszło do repo

```
Showcase WEB/
  supabase/support-schema.sql      ← cały schemat: tabele, role, funkcje. Uruchamiasz raz.
  api/_lib/db.js                   ← rozmowa z Supabase (PostgREST, klucz service role)
  api/_lib/mail.js                 ← Resend: wysyłka, odbiór, podpisy webhooków
  api/_lib/staff-session.js        ← ciasteczka sesji, hash PIN-u, Turnstile, uprawnienia
  api/staff/[...path].js           ← logowanie Google, PIN, zarządzanie zespołem
  api/support/[...path].js         ← tickety, wiadomości, raporty, KB, webhook poczty
  public/admin/index.html          ← panel (był tu stary formularz maintenance)
  public/admin/app.js
  public/admin/admin.css
  public/admin/legacy.html         ← stary panel maintenance, jako wyjście awaryjne
  .env.example                     ← opis każdej zmiennej środowiskowej
  vercel.json                      ← osobne CSP dla /admin (Turnstile + awatary Google)

Application APK/
  src/lib/staff.ts                 ← useStaff() / can() — te same role w aplikacji
```

Dwa pliki API zamiast kilkunastu, bo **Vercel Hobby dopuszcza 12 funkcji na deployment**.
Routing siedzi w środku każdego pliku.

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
   **Dodaj identyfikator URI**, i wpisz **oba**, każdy osobno:

   ```
   https://www.plately.eu/api/staff/callback
   https://plately.eu/api/staff/callback
   ```

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

Turnstile stoi wyłącznie przed PIN-em — przy każdej próbie, bez tokenu request nie
przechodzi. Sam ekran logowania nie jest bramkowany: oddaje ruch do Google, które ma własną
ochronę przed botami, a pół-sesja bez PIN-u nie otwiera żadnego endpointu.

---

## 4. Sekrety i zmienne w Vercelu

**Najpierw spójrz na listę, która już tam jest.** `SESSION_SECRET` i `PEPPER` na 99%
istnieją — używa ich dzisiejszy panel maintenance. Vercel nie pozwoli dodać drugiej
zmiennej o tej samej nazwie („A variable with the name … already exists"), i bardzo dobrze:

- `SESSION_SECRET` — zostaw istniejący. Nowy panel podpisze nim swoje ciasteczka tak samo.
- `PEPPER` — **zostaw istniejący, nie podmieniaj.** Na nim policzony jest
  `ADMIN_PASSWORD_HASH` do `/admin/legacy`; nowa wartość zabija to wejście awaryjne.
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

Szybki test, że funkcje wstały (bez zalogowania):

```bash
curl -s https://plately.eu/api/staff/session
```

Oczekiwane: `{"state":"signed_out","turnstileSiteKey":"0x4AAA…","googleConfigured":true}`.
Jeśli widzisz `googleConfigured: false` — zmienne nie doszły, zrób redeploy.

---

## 6. Pierwsze logowanie

1. Wejdź na `https://plately.eu/admin`.
2. **Continue with Google** → wybierz adres z kroku 1.
3. Panel poprosi o **ustawienie PIN-u** (pierwsze uruchomienie): cztery cyfry, dwa razy.
   Odrzuci `0000`, `1234` i kilka innych oczywistych.
4. Jesteś w środku. Inbox będzie pusty do kroku 8.

**Zablokowanie się jest odwracalne** — patrz sekcja „Kiedy coś pójdzie nie tak".

---

## 7. Poczta: wysyłka z contact@plately.eu

DNS plately.eu jest na **Spaceship** (`launch1/launch2.spaceship.net`) i tam zostaje.
Rekordy do wysyłki lądują na subdomenie `send.` — **apex zostaje nietknięty**, więc ten krok
niczego jeszcze nie psuje.

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

Test: w panelu **New ticket** → wpisz swój prywatny adres, temat i treść → *Create and send*.
Mail powinien dojść z `Plately Support <contact@plately.eu>`, a w panelu pojawia się ticket
`SUP-1000`.

---

## 8. Poczta: odbiór na contact@plately.eu

> ⚠️ **Ten krok wyłącza dotychczasowe przekierowanie ze Spaceship.** Dziś apex ma
> `MX → mx1/mx2.efwd.spaceship.net`, czyli darmowe forwardowanie. Po podmianie na MX Resenda
> **każdy** adres `@plately.eu` (contact@, hello@, cokolwiek) trafia do Resenda, a nie na
> Gmaila. To jest właśnie cel — panel staje się skrzynką — ale warto wiedzieć zawczasu.
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

Test: z prywatnej skrzynki napisz na `contact@plately.eu`. W ciągu kilkunastu sekund
w Inboxie pojawia się nowy ticket, a nadawca dostaje automatyczne potwierdzenie
(z numerem `SUP-…`, treść edytujesz w *Settings → E-mail channel*).

Test wątkowania: odpowiedz z panelu, potem odpisz ze swojej skrzynki na tę odpowiedź.
Powinno dokleić się do **tego samego** ticketu, a nie założyć nowy.

---

## 9. Jak to jest poskładane (żeby dało się to potem debugować)

**Logowanie.** `POST /api/staff/start` zwraca URL Google, zapisując
`state` + `nonce` w podpisanym ciasteczku. `GET /api/staff/callback` wymienia kod na
`id_token`, sprawdza `aud`/`iss`/`nonce`, szuka adresu w `staff` i wydaje **pół-sesję** —
dowód Google i nic więcej. Dopiero `POST /api/staff/pin` (PIN + Turnstile) wydaje właściwe
ciasteczko sesji na 12 godzin. Konto Google jest przypinane przy pierwszym logowaniu
(`google_sub`): ten sam adres z innego konta Google to inna osoba i dostaje odmowę.

**PIN.** PBKDF2-SHA256, sól per osoba w bazie + `PEPPER` ze zmiennej. Pięć błędnych prób
= 15 minut blokady. PIN-u nie da się „zresetować sobie samemu" — robi to owner
(*Settings → Team and roles → Edit → Reset PIN*).

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

## 10. Role i tiery

| | owner | admin | agent T3 | agent T2 | agent T1 | viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Czytanie ticketów, klientów, raportów | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Odpowiedź, notatka, tag, priorytet, „solved" | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Przypisanie do siebie | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Eskalacja, zwrot, przypisanie komuś innemu | ✅ | ✅ | ✅ | ✅ | — | — |
| Otwarcie zamkniętego, spam, usunięcie ticketu | ✅ | ✅ | ✅ | — | — | — |
| Ustawienia biurka, baza wiedzy, **tryb maintenance** | ✅ | ✅ | — | — | — | — |
| Dodawanie ludzi i zmiana ról | ✅ | — | — | — | — | — |

Dodanie agenta: *Settings → Team and roles → Add agent*. Wpisujesz adres Google, rolę i tier —
i to cała „rejestracja": osoba wchodzi na `/admin`, loguje się tym adresem i ustawia własny PIN.
Nic nie jest wysyłane mailem.

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

## 11. Kiedy coś pójdzie nie tak

**Nie mogę się zalogować / zgubiłem PIN.**
Supabase → SQL Editor:

```sql
-- kasuje PIN, przy następnym logowaniu ustawisz nowy
update public.staff
   set pin_hash = null, pin_salt = null, pin_set_at = null,
       failed_pin_attempts = 0, locked_until = null
 where lower(email) = 'twoj.adres@gmail.com';
```

**Google w ogóle nie działa, a muszę wyłączyć stronę.**
`https://plately.eu/admin/legacy` — stary formularz login/hasło (`ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`), robi dokładnie to, co robił wcześniej. Gdy nowe logowanie się
sprawdzi, skasuj te zmienne w Vercelu — strona przestanie działać i o to chodzi.

**„That Google account is not on the support team"** — brak wiersza w `staff` dla tego
adresu, albo `active = false`.

**`redirect_uri_mismatch`** — w Google Cloud (**Platforma Google Auth → Klienci →** Twój
klient **→ Autoryzowane identyfikatory URI przekierowania**) brakuje dokładnie tego adresu,
z którego wchodzisz. Najczęściej: dodany jest `www.plately.eu`, a wszedłeś na apex
`plately.eu` (albo odwrotnie). Mają tam być oba.

**Mail nie zakłada ticketu.** Po kolei: MX pokazuje Resenda (`nslookup -type=MX`)?
W Resend → Webhooks → Attempts widać próby i kod odpowiedzi? 401 = zły albo brakujący
`RESEND_WEBHOOK_SECRET`. Cisza = MX jeszcze się nie rozpropagował.

**Odpowiedź nie wychodzi.** Vercel → Deployments → Functions → logi
`api/support/[...path]`. Najczęściej: domena w Resend nie przeszła weryfikacji albo klucz
API nie ma *Full access*.

**Panel wygląda jak sprzed zmian.** `admin.css` i `app.js` mają godzinny cache — podbij
`?v=` w `public/admin/index.html`.

---

## 12. Limity, o których warto pamiętać

- **Resend free: 3 000 maili/miesiąc, 100/dzień**, i **odbiór liczy się do tej samej puli**.
  Jeden ticket to zwykle 1 (przychodzący) + 1 (auto-potwierdzenie) + 1 (odpowiedź) = 3 sztuki.
  W praktyce ~30 ticketów dziennie. Auto-potwierdzenie można wyłączyć w *Settings*.
- **Vercel Hobby: 12 funkcji na deployment.** Teraz jest 6 (4 stare `api/admin/*` + 2 nowe).
  Dokładając kolejne endpointy dopisuj trasy do istniejących plików `[...path].js`.
- **Supabase free**: 500 MB bazy. Tickety to tekst — starczy na bardzo długo.
- Sesja panelu: 12 godzin. Potem znowu Google + PIN.
- Odświeżanie listy: co 30 sekund, tylko gdy karta jest widoczna i nie masz otwartego okna
  modalnego. Nigdy nie nadpisuje tego, co masz wpisane w polu odpowiedzi.
