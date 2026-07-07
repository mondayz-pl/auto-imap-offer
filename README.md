# Oferta Bot — automatyczne generowanie ofert na podstawie maili (IMAP wp.pl)

Demo / szkielet pod konkretny case: bot monitoruje skrzynkę klienta na WP.pl,
wykrywa zapytania ofertowe, dopasowuje pozycje z cennika CSV i zapisuje
gotowy draft odpowiedzi w folderze "Wersje robocze" — do ręcznej weryfikacji
i wysłania przez klienta. Bot NIGDY nie wysyła maili samodzielnie.

## Status

Działający SZKIELET na fikcyjnych danych testowych pensjonatu "W Zaciszu"
(`data/cennik.csv`, `data/przykladowy-mail.txt`). Logika klasyfikacji,
ekstrakcji, generowania oferty i budowania wiadomości jest kompletna.
Opis biznesu (a więc i to, co bot uznaje za "zapytanie ofertowe") jest
konfigurowalny przez `BUSINESS_DESCRIPTION` w `.env` — ten sam kod obsłuży
pensjonat, agencję czy warsztat. Przed wdrożeniem produkcyjnym do
podstawienia: realny cennik, dane firmy i dostępy IMAP.

## Szybki start (test bez IMAP, tylko pipeline AI)

```bash
npm install
cp .env.example .env
# wpisz w .env swój ANTHROPIC_API_KEY

npm run test:single
```

To uruchomi klasyfikację → ekstrakcję → generowanie oferty na przykładowym
mailu z `data/przykladowy-mail.txt`, bez łączenia się z jakąkolwiek
skrzynką pocztową. Najlepszy sposób, by ocenić jakość promptów i dopasowania
cennika przed podłączeniem realnej skrzynki.

Testy jednostkowe (parsowanie cennika, rejestr przetworzonych maili — bez
API i bez IMAP):

```bash
npm test
```

## Pełne uruchomienie (z IMAP)

```bash
npm install
cp .env.example .env
# uzupełnij WSZYSTKIE zmienne w .env (IMAP_*, ANTHROPIC_API_KEY, COMPANY_*, BUSINESS_DESCRIPTION)

npm start
```

Bot będzie sprawdzał skrzynkę co `POLL_INTERVAL_MINUTES` minut (domyślnie 3).
Brakujące wymagane zmienne środowiskowe są wykrywane na starcie — bot wtedy
nie wystartuje i wypisze, czego brakuje.

### Przed pierwszym uruchomieniem produkcyjnym sprawdź:

1. **Czy IMAP/SMTP jest włączony w panelu WP.pl** dla danej skrzynki — to
   trzeba aktywować ręcznie po stronie panelu pocztowego klienta.
2. **Dokładną nazwę folderu Drafts.** `src/imap.js` próbuje wykryć ją
   automatycznie (też przez flagę `\Drafts`), ale warto zweryfikować ręcznie
   przez dowolny klient IMAP (np. Thunderbird) jak się ten folder nazywa
   na koncie konkretnego klienta.
3. **Czy hasło zwykłe wystarczy, czy trzeba hasła aplikacji** (zależy od
   ustawień 2FA na koncie wp.pl).
4. **Realny cennik klienta** w `data/cennik.csv` — zachowaj dokładnie ten
   format kolumn (`kategoria,usluga,jednostka,cena_netto,opis`), pamiętaj
   o cytowaniu (`"..."`) pól z przecinkami w treści.
5. **`BUSINESS_DESCRIPTION` w `.env`** — od tego opisu zależy klasyfikacja
   maili; opisz konkretnie, co firma świadczy.

## Uruchomienie produkcyjne 24/7 (PM2)

Żeby bot przetrwał restart serwera i automatycznie się odradzał po awarii:

```bash
npm install -g pm2
pm2 start src/index.js --name oferta-bot
pm2 save
pm2 startup    # skonfiguruje autostart po reboot serwera
```

Podgląd logów na żywo:
```bash
pm2 logs oferta-bot
# albo bezpośrednio z plików (ścieżka względem katalogu projektu, niezależnie od cwd):
tail -f logs/bot.log
```

## Struktura projektu

```
src/
  index.js            - punkt wejścia: walidacja env + pętla (setTimeout, nie node-cron - prościej)
  orchestrator.js     - główna logika: jeden cykl + obsługa pojedynczego maila
  imap.js             - połączenie IMAP, wykrywanie folderu Drafts, pobieranie maili, zapis draftów
  ai.js               - 3 funkcje: classifyEmail, extractInquiryData, generateOffer
  pricing.js          - wczytywanie i formatowanie cennika z CSV
  processed-store.js  - lokalny rejestr przetworzonych maili (deduplikacja + licznik prób)
  logger.js           - konfiguracja logowania (konsola + plik)
  test-single-run.js  - test pipeline AI bez IMAP, na statycznym przykładzie
test/                 - testy jednostkowe (node --test), bez API i bez IMAP
data/
  cennik.csv          - PRZYKŁADOWY cennik (do zastąpienia realnymi danymi klienta)
  cennik-uwagi.txt    - zasady cennika dla AI (sezonowość, wyjątki)
  przykladowy-mail.txt - przykładowe zapytanie ofertowe do testów
  processed-store.json - rejestr przetworzonych maili (tworzy się sam; nie commitować)
```

## Bezpieczniki wbudowane w logikę

- **Deduplikacja dwutorowa**: lokalny rejestr UID-ów (`data/processed-store.json`,
  autorytatywny) + custom flaga IMAP (best effort — część serwerów nie wspiera
  trwałych custom flag i wtedy sama flaga by nie wystarczyła). Rejestr pilnuje
  też UIDVALIDITY skrzynki.
- **Pierwsze uruchomienie nie przetwarza historii skrzynki** — bot obsługuje
  tylko maile od daty pierwszego startu (zapisanej w rejestrze).
- **Limit maili na cykl** (`MAX_EMAILS_PER_CYCLE`, domyślnie 10) — bezpiecznik
  kosztowy na wypadek nagłego zalewu maili.
- **Limit prób na mail** (`MAX_ATTEMPTS_PER_EMAIL`, domyślnie 3) — trwale
  zepsuty mail jest porzucany (wpis "porzucam" w logach = obsłuż ręcznie),
  zamiast generować koszty API w każdym cyklu w nieskończoność.
- Mail jest oznaczany jako przetworzony tylko PO pomyślnym wygenerowaniu
  draftu (albo po jednoznacznym odrzuceniu jako "nie-ofertowy") — przejściowy
  błąd nie gubi maila, bot spróbuje ponownie w następnym cyklu.
- Błąd na jednym mailu nie przerywa przetwarzania kolejnych w tej samej
  partii (try/catch per-mail).
- **Structured outputs** — klasyfikacja i ekstrakcja wymuszają na API JSON
  zgodny ze schematem, więc odpada zgadywanie, czy model nie dopisał czegoś
  od siebie. Ucięcie odpowiedzi limitem tokenów jest wykrywane (`stop_reason`)
  i traktowane jako błąd, a nie zapisywane jako niekompletna oferta.
- Generowanie oferty ma w prompcie wyraźny zakaz wymyślania cen/usług poza
  cennikiem — model ma instrukcję zaznaczyć niedopasowanie i zaproponować
  kontakt, a nie zgadywać.
- Niska pewność klasyfikacji nie blokuje wygenerowania draftu (lepiej dać
  człowiekowi gotowy szkic do oceny niż zgubić potencjalnego klienta) —
  takie przypadki są oznaczane warningiem w logach.
- Draft odpowiedzi idzie na adres z `Reply-To` nadawcy (fallback: `From`)
  i zawiera `In-Reply-To`/`References`, więc wątkuje się z oryginałem.
  Wiadomość buduje nodemailer (MailComposer) — poprawne kodowanie polskich
  znaków w nagłówkach.
- Treść maila wysyłana do modelu jest przycinana do 8000 znaków, a HTML
  konwertowany do tekstu — wielki newsletter nie wygeneruje wielkiego kosztu.

## Znane ograniczenia

- Jeśli draft zapisze się poprawnie, a tuż po tym zerwie się połączenie
  (przed oznaczeniem maila jako przetworzonego), następny cykl może
  wygenerować drugi draft dla tego samego maila. Rzadkie i niegroźne —
  człowiek weryfikuje drafty przed wysyłką.
- IMAP `SINCE` ma ziarnistość dnia, więc pierwszego dnia działania bot może
  pobrać z serwera także maile sprzed godziny startu — odfiltruje je rejestr,
  ale trafią do wyszukiwania.
