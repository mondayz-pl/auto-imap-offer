import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

/**
 * Lokalny rejestr przetworzonych maili (plik JSON).
 *
 * Dlaczego to istnieje: część serwerów IMAP (w tym niektóre polskie hostingi)
 * nie pozwala na trwałe custom flagi (brak "\*" w PERMANENTFLAGS). Wtedy
 * ustawienie flagi PROCESSED_FLAG po cichu nie zapisuje się na serwerze
 * i bot generowałby duplikaty ofert w każdym cyklu. Rejestr lokalny jest
 * autorytatywny; flaga IMAP pozostaje jako dodatkowe oznaczenie widoczne
 * z zewnątrz (np. w Thunderbirdzie).
 *
 * Rejestr trzyma też licznik nieudanych prób per mail, żeby trwale zepsuty
 * mail nie był ponawiany (i nie generował kosztów API) w nieskończoność.
 */
export async function openStore(storePath) {
  let data = null;
  try {
    data = JSON.parse(await readFile(storePath, 'utf-8'));
  } catch {
    // brak pliku albo uszkodzony JSON - zaczynamy od zera
  }

  if (!data || typeof data !== 'object' || typeof data.processed !== 'object') {
    data = {
      uidValidity: null,
      // Data pierwszego uruchomienia - bot przetwarza tylko maile od tego momentu,
      // żeby pierwszy start na pełnej skrzynce nie wygenerował setek ofert naraz.
      startDate: new Date().toISOString(),
      processed: {},
      failures: {},
    };
    logger.info({ storePath, startDate: data.startDate }, 'Utworzono nowy rejestr przetworzonych maili');
  }
  if (typeof data.failures !== 'object' || data.failures === null) data.failures = {};

  return {
    getStartDate: () => data.startDate,

    /**
     * UID-y maili są ważne tylko w obrębie jednej wartości UIDVALIDITY skrzynki.
     * Jeśli serwer ją zmienił (np. odtworzenie skrzynki), stare UID-y nic nie
     * znaczą i rejestr trzeba wyczyścić.
     */
    syncUidValidity(uidValidity) {
      const incoming = String(uidValidity);
      if (data.uidValidity && data.uidValidity !== incoming) {
        logger.warn(
          { old: data.uidValidity, new: incoming },
          'UIDVALIDITY skrzynki się zmieniło - czyszczę rejestr UID-ów'
        );
        data.processed = {};
        data.failures = {};
      }
      data.uidValidity = incoming;
    },

    isProcessed: (uid) => Boolean(data.processed[String(uid)]),

    markProcessed(uid) {
      data.processed[String(uid)] = new Date().toISOString();
      delete data.failures[String(uid)];
    },

    /** Zwraca liczbę dotychczasowych nieudanych prób (łącznie z tą). */
    recordFailure(uid) {
      const key = String(uid);
      data.failures[key] = (data.failures[key] || 0) + 1;
      return data.failures[key];
    },

    async save() {
      await mkdir(path.dirname(storePath), { recursive: true });
      await writeFile(storePath, JSON.stringify(data, null, 2), 'utf-8');
    },
  };
}
