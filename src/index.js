import 'dotenv/config';
import { logger } from './logger.js';
import { runCycle } from './orchestrator.js';
import { startStatusServer } from './status-server.js';

// Walidacja konfiguracji na starcie - brak któregoś z tych wpisów i tak
// wywali się w środku cyklu, tylko dużo mniej czytelnie.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const REQUIRED_ENV = [
  AI_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD',
];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  logger.error({ missing }, 'Brak wymaganych zmiennych środowiskowych - uzupełnij .env i uruchom ponownie');
  process.exit(1);
}

const intervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '3', 10);
const intervalMs = intervalMinutes * 60 * 1000;

async function loop() {
  try {
    await runCycle();
  } catch (err) {
    // Błąd na poziomie całego cyklu (np. utrata połączenia IMAP) -
    // logujemy i czekamy na następny cykl, proces NIE umiera.
    logger.error({ err: err.message, stack: err.stack }, 'Błąd cyklu - bot będzie próbował dalej');
  }

  setTimeout(loop, intervalMs);
}

startStatusServer();
logger.info({ intervalMinutes }, 'Start bota ofertowego');
loop();
