import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

// Ścieżka logów wyliczana względem tego pliku, nie względem katalogu
// uruchomienia - pod PM2/cronem cwd bywa inne i logi ginęłyby gdzie indziej.
const logFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'bot.log');

// W produkcji logi idą do pliku + stdout, żeby dało się je podglądać przez SSH (tail -f)
// i jednocześnie mieć trwały zapis do debugowania błędów parsowania.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
        level: 'info',
      },
      {
        target: 'pino/file',
        options: { destination: logFile, mkdir: true },
        level: 'debug',
      },
    ],
  },
});
