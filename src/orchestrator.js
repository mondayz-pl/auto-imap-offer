import { logger } from './logger.js';
import { stats } from './stats.js';
import { loadPricing, formatPricingForPrompt, loadPricingNotes } from './pricing.js';
import { classifyEmail, extractInquiryData, generateOffer } from './ai.js';
import { openStore } from './processed-store.js';
import {
  connectImap,
  resolveDraftsFolder,
  fetchUnprocessedEmails,
  markAsProcessed,
  saveDraft,
} from './imap.js';

// Po tylu nieudanych próbach mail jest porzucany (oznaczany jako przetworzony),
// żeby trwale zepsuty mail nie generował kosztów API w każdym cyklu.
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS_PER_EMAIL || '3', 10);

/**
 * Jeden pełny cykl: połącz -> sprawdź maile -> dla każdego: klasyfikuj -> ekstrahuj
 * -> wygeneruj ofertę -> zapisz draft -> oznacz jako przetworzony.
 *
 * Zaprojektowane tak, żeby błąd na JEDNYM mailu nie przerywał przetwarzania
 * pozostałych - każdy mail jest obsługiwany w try/catch niezależnie.
 */
export async function runCycle() {
  const cycleStart = Date.now();
  logger.info('--- Start cyklu sprawdzania skrzynki ---');
  let cycleEmailsProcessed = 0;

  const pricing = await loadPricing(process.env.PRICING_CSV_PATH || './data/cennik.csv');
  const pricingText = formatPricingForPrompt(pricing);
  const pricingNotes = await loadPricingNotes(process.env.PRICING_NOTES_PATH);
  const customInstructions = await loadPricingNotes(
    process.env.CUSTOM_INSTRUCTIONS_PATH || './data/dodatkowe-instrukcje.txt'
  );
  const emailTemplate = await loadPricingNotes(
    process.env.EMAIL_TEMPLATE_PATH || './data/szablon-maila.txt'
  );
  const store = await openStore(process.env.PROCESSED_STORE_PATH || './data/processed-store.json');

  const client = await connectImap();
  const processedFlag = process.env.PROCESSED_FLAG || 'AI-Processed';
  const maxCount = parseInt(process.env.MAX_EMAILS_PER_CYCLE || '10', 10);

  try {
    // Wewnątrz try/finally - błąd wykrywania folderu Drafts nie może
    // zostawić wiszącego połączenia IMAP.
    const draftsFolder = await resolveDraftsFolder(client, process.env.IMAP_DRAFTS_FOLDER);

    const emails = await fetchUnprocessedEmails(client, processedFlag, store, { maxCount });

    for (const email of emails) {
      const processed = await handleSingleEmail({ client, email, pricingText, pricingNotes, draftsFolder, processedFlag, store });
      if (processed) cycleEmailsProcessed++;
    }
  } finally {
    const durationMs = Date.now() - cycleStart;
    // logout może rzucić przy zerwanym połączeniu - to już nie jest nasz problem
    await client.logout().catch(() => {});
    logger.info({ durationMs }, '--- Koniec cyklu ---');

    stats.lastCycleAt = new Date();
    stats.lastCycleDurationMs = durationMs;
    stats.lastCycleStatus = 'ok';
    stats.cyclesTotal++;
    stats.emailsProcessed += cycleEmailsProcessed;
  }
}

async function handleSingleEmail({ client, email, pricingText, pricingNotes, draftsFolder, processedFlag, store }) {
  const ctx = { uid: email.uid, from: email.from, subject: email.subject };

  try {
    // Mail z nagłówkiem In-Reply-To to odpowiedź klienta na istniejący wątek
    // (np. klient dopytuje po otrzymaniu oferty) — nie generujemy nowej oferty.
    if (email.inReplyTo) {
      logger.info({ ...ctx, inReplyTo: email.inReplyTo }, 'Mail jest odpowiedzią w wątku - pomijam bez generowania oferty');
      await markAsProcessed(client, email.uid, processedFlag, store);
      return;
    }

    logger.info(ctx, 'Analiza maila: klasyfikacja');
    const classification = await classifyEmail(email);

    if (!classification.is_offer_request) {
      logger.info(
        { ...ctx, reason: classification.reason },
        'Mail odrzucony - nie jest zapytaniem ofertowym'
      );
      // Oznaczamy jako przetworzony, ale NIE generujemy oferty.
      await markAsProcessed(client, email.uid, processedFlag, store);
      return;
    }

    // Niska pewność klasyfikacji nie blokuje wygenerowania draftu - lepiej dać
    // człowiekowi gotowy szkic do poprawki/odrzucenia niż zgubić potencjalnego
    // klienta. Warning w logach pozwala takie przypadki wyłapać przy przeglądzie.
    if (classification.confidence === 'low') {
      logger.warn(ctx, 'Niska pewność klasyfikacji - draft i tak zostanie wygenerowany do weryfikacji');
    }

    logger.info(ctx, 'Ekstrakcja danych z zapytania');
    const extractedData = await extractInquiryData(email);

    logger.info(ctx, 'Generowanie treści oferty');
    const offerText = await generateOffer({
      extractedData,
      pricingText,
      pricingNotes,
      customInstructions,
      emailTemplate,
      companyName: process.env.COMPANY_NAME,
      // dotenv nie interpretuje "\n" w wartościach - zamieniamy literalne
      // backslash-n na prawdziwe nowe linie, żeby podpis był wielolinijkowy.
      companySignature: (process.env.COMPANY_SIGNATURE || '').replace(/\\n/g, '\n'),
    });

    const replySubject = email.subject.toLowerCase().startsWith('re:')
      ? email.subject
      : `Re: ${email.subject}`;

    await saveDraft(client, draftsFolder, {
      // Reply-To nadawcy ma pierwszeństwo; fallback na tekstowe From.
      to: email.replyTo || email.from,
      subject: replySubject,
      text: offerText,
      inReplyTo: email.messageId,
    });

    await markAsProcessed(client, email.uid, processedFlag, store);
    logger.info(ctx, 'Mail obsłużony pomyślnie - draft czeka na weryfikację');
    return true;
  } catch (err) {
    const attempts = store.recordFailure(email.uid);
    await store.save().catch(() => {});
    stats.lastCycleStatus = 'error';
    stats.lastError = err.message;
    logger.error(
      { ...ctx, attempts, err: err.message, stack: err.stack },
      'Błąd przetwarzania maila'
    );

    if (attempts >= MAX_ATTEMPTS) {
      // Trwale zepsuty mail: porzucamy go, żeby nie palić kwoty API co cykl.
      logger.error({ ...ctx, attempts }, 'Porzucam mail po wyczerpaniu prób - obsłuż go ręcznie');
      await markAsProcessed(client, email.uid, processedFlag, store).catch((markErr) => {
        logger.error({ ...ctx, err: markErr.message }, 'Nie udało się oznaczyć porzuconego maila');
      });
    }
    return false;
  }
}
