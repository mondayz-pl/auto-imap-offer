import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { logger } from './logger.js';

// Limit treści maila wysyłanej do modelu - chroni przed kosztami przy
// wielkich mailach (newslettery HTML, długie łańcuchy odpowiedzi).
const MAX_TEXT_CHARS = 8000;

/**
 * Tworzy i zwraca połączony klient IMAP.
 * Pamiętaj: WP.pl (jak większość polskich hostingów) może wymagać włączenia
 * dostępu IMAP/SMTP w panelu poczty - to pierwsza rzecz do sprawdzenia,
 * jeśli logowanie się nie powiedzie.
 */
export async function connectImap() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT, 10),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASSWORD,
    },
    logger: false, // wyłączamy wbudowane logi imapflow, mamy własny logger
  });

  await client.connect();
  logger.info({ host: process.env.IMAP_HOST }, 'Połączono z serwerem IMAP');
  return client;
}

/**
 * KLUCZOWE: nazwa folderu Drafts na wp.pl bywa zlokalizowana ("Wersje robocze").
 * Ta funkcja sprawdza listę folderów i próbuje znaleźć właściwy automatycznie,
 * zamiast ślepo wierzyć wartości z .env - to zabezpiecza przed literówką/błędną
 * konfiguracją psującą cały proces zapisu ofert.
 */
export async function resolveDraftsFolder(client, configuredName) {
  const mailboxes = await client.list();

  // Najpierw sprawdzamy, czy skonfigurowana nazwa istnieje dokładnie
  const exactMatch = mailboxes.find((mb) => mb.path === configuredName);
  if (exactMatch) return exactMatch.path;

  // Fallback: szukamy po typowych nazwach/flagach folderu Drafts
  const candidates = ['Drafts', 'Wersje robocze', 'INBOX.Drafts', 'INBOX/Drafts'];
  for (const candidate of candidates) {
    const match = mailboxes.find((mb) => mb.path === candidate);
    if (match) {
      logger.warn(
        { configured: configuredName, found: candidate },
        'Skonfigurowana nazwa folderu Drafts nie istniała - użyto wykrytej automatycznie'
      );
      return match.path;
    }
  }

  // Fallback po specialUse flag (RFC 6154) - najbardziej solidna metoda gdy serwer ją wspiera
  const bySpecialUse = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
  if (bySpecialUse) return bySpecialUse.path;

  logger.error({ mailboxes: mailboxes.map((m) => m.path) }, 'Nie znaleziono folderu Drafts');
  throw new Error(
    'Nie udało się ustalić folderu Drafts. Sprawdź ręcznie listę folderów i ustaw IMAP_DRAFTS_FOLDER w .env'
  );
}

/** Zgrubna konwersja HTML -> tekst na potrzeby promptu (bez dodatkowej zależności). */
function htmlToPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pobiera nieprzetworzone maile z INBOX.
 *
 * "Nieprzetworzone" = nieobecne w lokalnym rejestrze (autorytatywny) i bez
 * naszej custom flagi na serwerze (dodatkowe zabezpieczenie). Zakres zawężamy
 * do maili od daty pierwszego uruchomienia bota (store.startDate) - dzięki temu
 * pierwszy start na pełnej skrzynce nie przetwarza całej historii - oraz do
 * maxCount sztuk na cykl.
 *
 * Celowo NIE filtrujemy po \Seen: klient może przeczytać mail w swoim programie
 * pocztowym zanim bot zdąży go obsłużyć i taki lead byłby po cichu zgubiony.
 */
export async function fetchUnprocessedEmails(client, processedFlag, store, { maxCount }) {
  const lock = await client.getMailboxLock('INBOX');
  const results = [];

  try {
    store.syncUidValidity(client.mailbox.uidValidity);

    if (client.mailbox.permanentFlags && !client.mailbox.permanentFlags.has('\\*')) {
      logger.warn(
        'Serwer nie wspiera trwałych custom flag IMAP - deduplikacja opiera się wyłącznie na lokalnym rejestrze'
      );
    }

    // IMAP SINCE ma ziarnistość dnia - maile z dnia startu sprzed godziny
    // startu też przyjdą, ale rejestr/flagi i tak je odfiltrują.
    const since = new Date(store.getStartDate());
    const uids = (await client.search({ since }, { uid: true })) || [];
    const candidates = uids.filter((uid) => !store.isProcessed(uid));

    // Najpierw tani przebieg po samych flagach (bez pobierania treści),
    // żeby odfiltrować maile oflagowane na serwerze i dopiero potem
    // ściągnąć pełne źródło tylko dla wybranych.
    const selected = [];
    if (candidates.length > 0) {
      for await (const msg of client.fetch(candidates.join(','), { flags: true, uid: true }, { uid: true })) {
        if (msg.flags?.has(processedFlag)) {
          // Flaga jest, a rejestru brak (np. rejestr założony później) - dosynchronizuj.
          store.markProcessed(msg.uid);
          continue;
        }
        selected.push(msg.uid);
      }
    }
    await store.save();

    if (selected.length > maxCount) {
      logger.warn(
        { pending: selected.length, maxCount },
        'Więcej nowych maili niż limit na cykl - reszta zostanie obsłużona w kolejnych cyklach'
      );
    }

    for (const uid of selected.slice(0, maxCount)) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      let text = parsed.text || (parsed.html ? htmlToPlainText(parsed.html) : '');
      if (text.length > MAX_TEXT_CHARS) {
        text = `${text.slice(0, MAX_TEXT_CHARS)}\n[...treść ucięta ze względu na długość...]`;
      }

      results.push({
        uid,
        subject: parsed.subject || '(brak tematu)',
        from: parsed.from?.text || 'nieznany nadawca',
        // Adres do odpowiedzi: Reply-To ma pierwszeństwo przed From.
        replyTo: parsed.replyTo?.value?.[0]?.address || parsed.from?.value?.[0]?.address || null,
        // Message-ID oryginału - draft odpowiedzi będzie się wątkował.
        messageId: parsed.messageId || null,
        text,
        date: parsed.date,
      });
    }
  } finally {
    lock.release();
  }

  logger.info({ count: results.length }, 'Pobrano nieprzetworzone maile do analizy');
  return results;
}

/**
 * Oznacza mail jako przetworzony: wpis w lokalnym rejestrze (autorytatywny)
 * + custom flaga na serwerze (best effort - patrz komentarz w processed-store.js).
 * Nie zmieniamy \Seen - nie chcemy ingerować w to, czy klient "przeczytał"
 * mail w swoim kliencie pocztowym.
 */
export async function markAsProcessed(client, uid, processedFlag, store) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    try {
      await client.messageFlagsAdd(String(uid), [processedFlag], { uid: true });
    } catch (err) {
      logger.warn(
        { uid, err: err.message },
        'Nie udało się ustawić flagi IMAP - polegam na lokalnym rejestrze'
      );
    }
    store.markProcessed(uid);
    await store.save();
  } finally {
    lock.release();
  }
}

/**
 * Zapisuje wygenerowaną ofertę jako DRAFT (nie wysyła!).
 * To jest IMAP APPEND, czyli dopisanie nowej wiadomości do folderu Drafts -
 * mail fizycznie nie jest wysyłany przez SMTP, tylko ląduje jako szkic
 * do ręcznej weryfikacji i wysłania przez klienta.
 *
 * Wiadomość buduje MailComposer z nodemailera (zamiast ręcznego sklejania
 * RFC 822): poprawne kodowanie polskich znaków w nagłówkach, łamanie linii
 * base64, Message-ID oraz In-Reply-To/References dla wątkowania.
 */
export async function saveDraft(client, draftsFolder, { to, subject, text, inReplyTo }) {
  const composer = new MailComposer({
    from: process.env.IMAP_USER,
    to,
    subject,
    text,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  const message = await composer.compile().build();

  await client.append(draftsFolder, message, ['\\Draft']);

  logger.info({ to, subject }, 'Zapisano draft oferty');
}
