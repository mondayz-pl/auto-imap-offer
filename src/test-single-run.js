import 'dotenv/config';
import { readFile } from 'fs/promises';
import { logger } from './logger.js';
import { loadPricing, formatPricingForPrompt, loadPricingNotes } from './pricing.js';
import { classifyEmail, extractInquiryData, generateOffer } from './ai.js';

/**
 * Test pojedynczego przebiegu na przykładowym mailu z data/przykladowy-mail.txt,
 * BEZ łączenia się z IMAP. Służy do szybkiej weryfikacji jakości promptów
 * i dopasowania cennika, zanim podłączysz prawdziwą skrzynkę klienta.
 *
 * Użycie: npm run test:single
 */
async function main() {
  const rawEmail = await readFile('./data/przykladowy-mail.txt', 'utf-8');
  const { subject, from, text } = parseSimpleEmailFile(rawEmail);

  const pricing = await loadPricing(process.env.PRICING_CSV_PATH || './data/cennik.csv');
  const pricingText = formatPricingForPrompt(pricing);
  const pricingNotes = await loadPricingNotes(process.env.PRICING_NOTES_PATH || './data/cennik-uwagi.txt');

  console.log('\n=== KROK 1: KLASYFIKACJA ===');
  const classification = await classifyEmail({ subject, from, text });
  console.log(JSON.stringify(classification, null, 2));

  if (!classification.is_offer_request) {
    console.log('\nMail zaklasyfikowany jako NIE-ofertowy. Koniec testu.');
    return;
  }

  console.log('\n=== KROK 2: EKSTRAKCJA DANYCH ===');
  const extractedData = await extractInquiryData({ subject, from, text });
  console.log(JSON.stringify(extractedData, null, 2));

  console.log('\n=== KROK 3: WYGENEROWANA OFERTA ===');
  const offer = await generateOffer({
    extractedData,
    pricingText,
    pricingNotes,
    companyName: process.env.COMPANY_NAME || 'W Zaciszu',
    companySignature: (process.env.COMPANY_SIGNATURE || 'Recepcja W Zaciszu').replace(/\\n/g, '\n'),
  });
  console.log(offer);
}

/** Bardzo prosty parser pliku .txt udającego surowy mail (tylko do testów lokalnych) */
export function parseSimpleEmailFile(raw) {
  const fromMatch = raw.match(/^From:\s*(.+)$/m);
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/m);
  const bodyStart = raw.indexOf('\n\n');

  return {
    from: fromMatch?.[1]?.trim() || 'nieznany',
    subject: subjectMatch?.[1]?.trim() || '(brak tematu)',
    text: bodyStart === -1 ? raw.trim() : raw.slice(bodyStart).trim(),
  };
}

// Uruchamiaj main() tylko gdy plik jest wywołany bezpośrednio (nie importowany w testach)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, 'Test nieudany');
    process.exit(1);
  });
}
