import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Modele dobrane pod typ zadania - Haiku do prostych zadań routingowych/
// ekstrakcyjnych, Sonnet do generowania treści oferty.
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MODEL_QUALITY = 'claude-sonnet-5';

// Opis biznesu wstrzykiwany do promptów - dzięki temu ten sam kod obsłuży
// pensjonat, agencję czy warsztat; wystarczy zmienić .env.
function businessDescription() {
  return (
    process.env.BUSINESS_DESCRIPTION ||
    'polska firma usługowa przyjmująca mailowe zapytania ofertowe od klientów'
  );
}

/** Wyciąga blok tekstowy z odpowiedzi API i pilnuje, żeby nie była ucięta. */
function getTextOrThrow(response, context) {
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Odpowiedź AI ucięta limitem max_tokens (${context}) - zwiększ limit`);
  }
  const block = response.content.find((b) => b.type === 'text');
  if (!block) {
    throw new Error(`Brak bloku tekstowego w odpowiedzi AI (${context})`);
  }
  return block.text.trim();
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

// Structured outputs (output_config.format) gwarantują po stronie API,
// że odpowiedź jest poprawnym JSON-em zgodnym ze schematem - żadnego
// zgadywania, czy model nie owinął odpowiedzi w ```json``` albo nie dopisał
// komentarza od siebie.
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    is_offer_request: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['is_offer_request', 'confidence', 'reason'],
  additionalProperties: false,
};

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    imie_nazwisko: nullableString,
    telefon: nullableString,
    nazwa_firmy_klienta: nullableString,
    branza_klienta: nullableString,
    uslugi_o_ktore_prosi: { type: 'array', items: { type: 'string' } },
    dodatkowy_kontekst: nullableString,
    ton_zapytania: { type: 'string', enum: ['formalny', 'nieformalny', 'neutralny'] },
  },
  required: [
    'imie_nazwisko',
    'telefon',
    'nazwa_firmy_klienta',
    'branza_klienta',
    'uslugi_o_ktore_prosi',
    'dodatkowy_kontekst',
    'ton_zapytania',
  ],
  additionalProperties: false,
};

/**
 * KROK 1: Klasyfikacja - czy to mail z zapytaniem ofertowym?
 * Zwraca strukturalny wynik, żeby dało się to logować i analizować błędy.
 */
export async function classifyEmail({ subject, text, from }) {
  const response = await anthropic.messages.create({
    model: MODEL_FAST,
    max_tokens: 400,
    system: `Klasyfikujesz maile przychodzące do firmy: ${businessDescription()}.

Twoje zadanie: ocenić, czy dany mail jest ZAPYTANIEM OFERTOWYM od potencjalnego
klienta - prośbą o wycenę, ofertę, cennik, dostępność lub rezerwację usług,
które ta firma świadczy.

NIE są zapytaniami ofertowymi: newslettery, spam, faktury, powiadomienia
systemowe, maile od istniejących klientów dot. już trwających rezerwacji/zleceń,
oferty SPRZEDAŻOWE przychodzące DO firmy (np. od innych firm chcących jej coś
sprzedać).

W polu "reason" podaj krótkie uzasadnienie po polsku.`,
    output_config: { format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Od: ${from}\nTemat: ${subject}\n\nTreść:\n${text}`,
      },
    ],
  });

  const raw = getTextOrThrow(response, 'klasyfikacja');
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw, err: err.message }, 'Nie udało się sparsować odpowiedzi klasyfikacji');
    throw new Error('Błąd parsowania klasyfikacji AI - mail wymaga ponownej próby');
  }
}

/**
 * KROK 2: Ekstrakcja - wyciągnięcie ustrukturyzowanych danych z treści zapytania.
 */
export async function extractInquiryData({ subject, text, from }) {
  const response = await anthropic.messages.create({
    model: MODEL_FAST,
    max_tokens: 1000,
    system: `Wyciągasz ustrukturyzowane dane z zapytania ofertowego klienta firmy:
${businessDescription()}.

Czytasz treść maila i wyciągasz to, czego klient potrzebuje:
- dane kontaktowe (imię i nazwisko, telefon, firma, branża - jeśli podane),
- listę usług, o które prosi (krótkie opisy po polsku),
- dodatkowy kontekst: budżet, terminy, liczba osób/nocy, preferencje itd.,
- ton zapytania (formalny/nieformalny/neutralny).

Jeśli czegoś nie da się wyciągnąć z treści, wpisz null. Nie zgaduj danych,
których nie ma w tekście.`,
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Od: ${from}\nTemat: ${subject}\n\nTreść:\n${text}`,
      },
    ],
  });

  const raw = getTextOrThrow(response, 'ekstrakcja');
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error({ raw, err: err.message }, 'Nie udało się sparsować ekstrakcji danych');
    throw new Error('Ekstrakcja danych nie powiodła się - mail wymaga ponownej próby');
  }
}

/**
 * KROK 3: Generowanie treści oferty na bazie wyciągniętych danych + cennika.
 */
export async function generateOffer({ extractedData, pricingText, pricingNotes, companyName, companySignature }) {
  const response = await anthropic.messages.create({
    model: MODEL_QUALITY,
    max_tokens: 2000,
    system: `Piszesz w imieniu firmy "${companyName}" profesjonalną, ciepłą ale konkretną
ofertę handlową w odpowiedzi na zapytanie klienta. Piszesz po polsku, w tonie B2B,
bez sztywnego "korpomowy", ale rzeczowo.

Zasady:
- Dopasuj WYŁĄCZNIE pozycje z podanego cennika do potrzeb klienta. Nie wymyślaj cen ani usług,
  których nie ma w cenniku.
- Jeśli zapytanie klienta nie pokrywa się dobrze z żadną pozycją cennika, zaznacz to wprost
  i zaproponuj kontakt w celu doprecyzowania zakresu - nie zgaduj.
- Zwróć cenę netto dla każdej pozycji oraz sumę.
- Format e-maila: zwięzłe wprowadzenie odnoszące się do zapytania klienta, lista proponowanych
  usług z cenami, krótkie podsumowanie/suma, zachęta do kontaktu/rozmowy, podpis.
- Podpisz się jako: "${companySignature}"
- Nie dodawaj nagłówków typu "Temat:" - tylko treść samego maila (będzie wklejona jako body).
- Pisz zwykłym tekstem (nie HTML, nie markdown z gwiazdkami).`,
    messages: [
      {
        role: 'user',
        content: `DANE Z ZAPYTANIA KLIENTA:
${JSON.stringify(extractedData, null, 2)}

DOSTĘPNY CENNIK:
${pricingText}
${pricingNotes ? `\nZASADY I UWAGI DO CENNIKA (przeczytaj przed doborem cen):\n${pricingNotes}` : ''}
Napisz treść oferty mailowej.`,
      },
    ],
  });

  return getTextOrThrow(response, 'generowanie oferty');
}
