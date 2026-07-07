import { readFile } from 'fs/promises';
import { parse } from 'csv-parse/sync';
import { logger } from './logger.js';

export async function loadPricingNotes(notesPath) {
  if (!notesPath) return null;
  try {
    const notes = await readFile(notesPath, 'utf-8');
    logger.info({ notesPath }, 'Uwagi do cennika wczytane');
    return notes;
  } catch {
    logger.warn({ notesPath }, 'Nie znaleziono pliku uwag do cennika - pomijam');
    return null;
  }
}

/**
 * Wczytuje cennik z CSV do pamięci.
 * Format CSV (nagłówki): kategoria,usluga,jednostka,cena_netto,opis
 *
 * Cennik jest wczytywany na nowo przy każdym cyklu bota (nie cache'owany na zawsze),
 * żeby klient mógł edytować plik CSV i zmiany od razu były widoczne bez restartu procesu.
 */
export async function loadPricing(csvPath) {
  const raw = await readFile(csvPath, 'utf-8');

  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const pricing = records.map((row) => ({
    kategoria: row.kategoria,
    usluga: row.usluga,
    jednostka: row.jednostka,
    cena_netto: parseFloat(row.cena_netto),
    opis: row.opis || '',
  }));

  logger.info({ count: pricing.length, csvPath }, 'Cennik wczytany');
  return pricing;
}

/**
 * Formatuje cennik do postaci tekstowej, którą wstrzykujemy do promptu Claude.
 * Trzymamy to w prostym, czytelnym formacie - model radzi sobie z tym lepiej
 * niż z surowym JSON-em przy dopasowywaniu pozycji do opisowego zapytania klienta.
 */
export function formatPricingForPrompt(pricing) {
  return pricing
    .map(
      (p) =>
        `- [${p.kategoria}] ${p.usluga} | ${p.cena_netto} zł netto / ${p.jednostka} | ${p.opis}`
    )
    .join('\n');
}
