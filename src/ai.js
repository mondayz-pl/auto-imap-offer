import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from './logger.js';

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  throw new Error('Brak ANTHROPIC_API_KEY w .env (wymagane gdy AI_PROVIDER=anthropic)');
}
if (PROVIDER === 'openai' && !process.env.OPENAI_API_KEY) {
  throw new Error('Brak OPENAI_API_KEY w .env (wymagane gdy AI_PROVIDER=openai)');
}

const anthropicClient = PROVIDER === 'anthropic'
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const openaiClient = PROVIDER === 'openai'
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Domyślne modele — można nadpisać w .env
const MODELS = {
  anthropic: {
    fast:    process.env.ANTHROPIC_MODEL_FAST    || 'claude-haiku-4-5-20251001',
    quality: process.env.ANTHROPIC_MODEL_QUALITY || 'claude-sonnet-5',
  },
  openai: {
    fast:    process.env.OPENAI_MODEL_FAST    || 'gpt-4o-mini',
    quality: process.env.OPENAI_MODEL_QUALITY || 'gpt-4o',
  },
};

function model(tier) {
  return MODELS[PROVIDER]?.[tier] ?? MODELS.anthropic[tier];
}

function businessDescription() {
  return (
    process.env.BUSINESS_DESCRIPTION ||
    'polska firma usługowa przyjmująca mailowe zapytania ofertowe od klientów'
  );
}

// ─── Warstwa abstrakcji ────────────────────────────────────────────────────────
// Jeden interfejs dla obu providerów. jsonSchema opcjonalne — gdy podane,
// odpowiedź jest gwarantowanym JSON-em zgodnym ze schematem.

async function callAI({ tier, system, prompt, maxTokens, jsonSchema = null, schemaName = 'result' }) {
  if (PROVIDER === 'openai') {
    const params = {
      model: model(tier),
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    if (jsonSchema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: schemaName, schema: jsonSchema, strict: true },
      };
    }
    const res = await openaiClient.chat.completions.create(params);
    if (res.choices[0].finish_reason === 'length') {
      throw new Error(`Odpowiedź AI ucięta limitem max_tokens (${schemaName}) - zwiększ limit`);
    }
    return res.choices[0].message.content.trim();
  }

  // Anthropic
  const params = {
    model: model(tier),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (jsonSchema) {
    params.output_config = { format: { type: 'json_schema', schema: jsonSchema } };
  }
  const res = await anthropicClient.messages.create(params);
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Odpowiedź AI ucięta limitem max_tokens (${schemaName}) - zwiększ limit`);
  }
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error(`Brak bloku tekstowego w odpowiedzi AI (${schemaName})`);
  return block.text.trim();
}

// ─── Schematy JSON ─────────────────────────────────────────────────────────────

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

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
    'imie_nazwisko', 'telefon', 'nazwa_firmy_klienta', 'branza_klienta',
    'uslugi_o_ktore_prosi', 'dodatkowy_kontekst', 'ton_zapytania',
  ],
  additionalProperties: false,
};

// ─── Publiczne funkcje ─────────────────────────────────────────────────────────

export async function classifyEmail({ subject, text, from }) {
  const raw = await callAI({
    tier: 'fast',
    maxTokens: 400,
    jsonSchema: CLASSIFICATION_SCHEMA,
    schemaName: 'klasyfikacja',
    system: `Klasyfikujesz maile przychodzące do firmy: ${businessDescription()}.

Twoje zadanie: ocenić, czy dany mail jest ZAPYTANIEM OFERTOWYM od potencjalnego
klienta - prośbą o wycenę, ofertę, cennik, dostępność lub rezerwację usług,
które ta firma świadczy.

NIE są zapytaniami ofertowymi: newslettery, spam, faktury, powiadomienia
systemowe, maile od istniejących klientów dot. już trwających rezerwacji/zleceń,
oferty SPRZEDAŻOWE przychodzące DO firmy (np. od innych firm chcących jej coś
sprzedać).

W polu "reason" podaj krótkie uzasadnienie po polsku.`,
    prompt: `Od: ${from}\nTemat: ${subject}\n\nTreść:\n${text}`,
  });

  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw, err: err.message }, 'Nie udało się sparsować odpowiedzi klasyfikacji');
    throw new Error('Błąd parsowania klasyfikacji AI - mail wymaga ponownej próby');
  }
}

export async function extractInquiryData({ subject, text, from }) {
  const raw = await callAI({
    tier: 'fast',
    maxTokens: 1000,
    jsonSchema: EXTRACTION_SCHEMA,
    schemaName: 'ekstrakcja',
    system: `Wyciągasz ustrukturyzowane dane z zapytania ofertowego klienta firmy:
${businessDescription()}.

Czytasz treść maila i wyciągasz to, czego klient potrzebuje:
- dane kontaktowe (imię i nazwisko, telefon, firma, branża - jeśli podane),
- listę usług, o które prosi (krótkie opisy po polsku),
- dodatkowy kontekst: budżet, terminy, liczba osób/nocy, preferencje itd.,
- ton zapytania (formalny/nieformalny/neutralny).

Jeśli czegoś nie da się wyciągnąć z treści, wpisz null. Nie zgaduj danych,
których nie ma w tekście.`,
    prompt: `Od: ${from}\nTemat: ${subject}\n\nTreść:\n${text}`,
  });

  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error({ raw, err: err.message }, 'Nie udało się sparsować ekstrakcji danych');
    throw new Error('Ekstrakcja danych nie powiodła się - mail wymaga ponownej próby');
  }
}

export async function generateOffer({ extractedData, pricingText, pricingNotes, companyName, companySignature }) {
  return callAI({
    tier: 'quality',
    maxTokens: 2000,
    schemaName: 'generowanie oferty',
    system: `Piszesz w imieniu ośrodka "${companyName}" ciepłą, konkretną ofertę
w odpowiedzi na zapytanie klienta. Piszesz po polsku, serdecznie ale rzeczowo.

ZASADY:
- Dopasuj WYŁĄCZNIE pozycje z podanego cennika. Nie wymyślaj cen ani usług spoza cennika.
- Jeśli zapytanie nie pasuje do żadnej pozycji cennika, zaznacz to wprost i zaproś do kontaktu.
- Podajesz ceny przy każdej pozycji. Sumę podaj tylko gdy dotyczy konkretnej rezerwacji z jasną liczbą osób/nocy.
- Podpisz się jako: "${companySignature}"
- Nie dodawaj nagłówka "Temat:" — tylko treść maila.
- Nie używaj markdown (gwiazdki, kreski). Używaj emoji do nagłówków sekcji i • do wypunktowania.

FORMAT OFERTY (trzymaj się tej struktury):

🏡 ${companyName}
Dzień dobry,
Będzie nam niezwykle miło gościć Państwa w naszej Agroturystyce.
Poniżej przedstawiamy szczegóły naszej oferty[, w terminie X – Y — tylko jeśli termin znany z zapytania].

[Sekcje dobierane do zapytania:]

🛏️ NOCLEG
[lista pokoi z cenami — format: "• Pokój X ze śniadaniem – Y zł / doba"]
🕒 Doba hotelowa trwa od godz. 15:00 do godz. 11:00 dnia wyjazdu.

🍽️ WYŻYWIENIE
• Śniadanie – bogaty bufet szwedzki w godz. 8:00–10:00 (wliczone w cenę noclegu)
[obiad i kolacja z cenami jeśli pytał lub jeśli dotyczy]
Proszę aby dodatkowe posiłki zamawiać z wyprzedzeniem.

🌿 NA TERENIE „ZACISZA" DO PAŃSTWA DYSPOZYCJI:
✅ bezpłatny parking (bez rezerwacji miejsc)
✅ boiska do piłki nożnej i siatkówki plażowej
✅ las, zwierzyniec
✅ bilard, siłownia, stoły do ping ponga
✅ w sezonie letnim zewnętrzny basen z podgrzewaną wodą
[zawsze dodaj tę sekcję przy zapytaniach o nocleg lub pobyt]

👩‍⚕️ DODATKOWO, ZA OPŁATĄ I REZERWACJĄ:
[płatne atrakcje jeśli pytał lub jeśli pasują do kontekstu wizyty]

[zamknięcie: prośba o dane do faktury jeśli dotyczy, zachęta do kontaktu]

${companySignature}`,
    prompt: `DANE Z ZAPYTANIA KLIENTA:
${JSON.stringify(extractedData, null, 2)}

DOSTĘPNY CENNIK:
${pricingText}
${pricingNotes ? `\nZASADY I UWAGI DO CENNIKA (przeczytaj przed doborem cen):\n${pricingNotes}` : ''}
Napisz treść oferty mailowej.`,
  });
}

logger.info({ provider: PROVIDER, modelFast: model('fast'), modelQuality: model('quality') }, 'AI provider załadowany');
