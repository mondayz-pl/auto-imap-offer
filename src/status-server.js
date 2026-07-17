import http from 'http';
import crypto from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { stats } from './stats.js';
import { logger } from './logger.js';

// ── Auth ──────────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => {
  const tmp = crypto.randomBytes(6).toString('hex');
  logger.warn(
    { haslo: tmp },
    'ADMIN_PASSWORD nie ustawiony w .env — tymczasowe hasło (zmień po pierwszym logowaniu!)'
  );
  return tmp;
})();

const SESSION_SECRET = crypto.createHash('sha256').update(ADMIN_PASSWORD + 'oferta-bot').digest('hex');

function createToken() {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(ts).digest('hex');
  return `${sig}.${ts}`;
}

function verifyToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const sig = token.slice(0, dot);
  const ts = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(ts).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
  } catch {
    return false;
  }
  return Date.now() - parseInt(ts, 10) < 86_400_000; // 24h
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').flatMap(c => {
      const [k, ...v] = c.trim().split('=');
      return k ? [[k.trim(), decodeURIComponent(v.join('='))]] : [];
    })
  );
}

function isAuth(req) {
  return verifyToken(parseCookies(req).session);
}

// ── Env file ──────────────────────────────────────────────────────────────────

const ENV_PATH = process.env.ENV_FILE_PATH || '.env';

function parseEnvContent(content) {
  const out = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // strip inline comment (only if not quoted)
    const commentIdx = val.indexOf(' #');
    if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    out[key] = val;
  }
  return out;
}

function applyUpdatesToEnv(original, updates) {
  const lines = original.split('\n');
  const handled = new Set();

  const result = lines.map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const idx = t.indexOf('=');
    if (idx === -1) return line;
    const key = t.slice(0, idx).trim();
    if (key in updates) {
      handled.add(key);
      const val = updates[key];
      if (val === '' || val === undefined) return line; // empty = keep
      const needsQuote = /[\s#"'\\]/.test(val);
      return `${key}=${needsQuote ? `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : val}`;
    }
    return line;
  });

  for (const [key, val] of Object.entries(updates)) {
    if (!handled.has(key) && val !== '' && val !== undefined) {
      const needsQuote = /[\s#"'\\]/.test(val);
      result.push(`${key}=${needsQuote ? `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : val}`);
    }
  }

  return result.join('\n');
}

async function readEnv() {
  try {
    return parseEnvContent(await readFile(ENV_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveEnv(updates) {
  let original = '';
  try { original = await readFile(ENV_PATH, 'utf-8'); } catch { /* nowy plik */ }
  await writeFile(ENV_PATH, applyUpdatesToEnv(original, updates), 'utf-8');
}

// ── Settings definition ───────────────────────────────────────────────────────

const SETTINGS_GROUPS = [
  {
    title: '🔐 Panel admina',
    fields: [
      { key: 'ADMIN_PASSWORD', label: 'Hasło do panelu', type: 'password', sensitive: true },
    ],
  },
  {
    title: '🤖 Dostawca AI',
    fields: [
      { key: 'AI_PROVIDER', label: 'Provider', type: 'select', options: ['anthropic', 'openai'] },
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', type: 'password', sensitive: true },
      { key: 'ANTHROPIC_MODEL_FAST', label: 'Anthropic — model szybki', type: 'text', placeholder: 'claude-haiku-4-5-20251001' },
      { key: 'ANTHROPIC_MODEL_QUALITY', label: 'Anthropic — model do ofert', type: 'text', placeholder: 'claude-sonnet-5' },
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', sensitive: true },
      { key: 'OPENAI_MODEL_FAST', label: 'OpenAI — model szybki', type: 'text', placeholder: 'gpt-4o-mini' },
      { key: 'OPENAI_MODEL_QUALITY', label: 'OpenAI — model do ofert', type: 'text', placeholder: 'gpt-4o' },
    ],
  },
  {
    title: '📬 Poczta IMAP',
    fields: [
      { key: 'IMAP_HOST', label: 'Serwer IMAP', type: 'text', placeholder: 'imap.wp.pl' },
      { key: 'IMAP_PORT', label: 'Port', type: 'text', placeholder: '993' },
      { key: 'IMAP_USER', label: 'Adres e-mail', type: 'text' },
      { key: 'IMAP_PASSWORD', label: 'Hasło do skrzynki', type: 'password', sensitive: true },
      { key: 'IMAP_DRAFTS_FOLDER', label: 'Folder Wersje robocze', type: 'text', placeholder: 'Wersje robocze' },
    ],
  },
  {
    title: '🏢 Firma',
    fields: [
      { key: 'COMPANY_NAME', label: 'Nazwa ośrodka / firmy', type: 'text' },
      { key: 'COMPANY_SIGNATURE', label: 'Podpis w mailach (\\n = nowa linia)', type: 'text' },
      { key: 'BUSINESS_DESCRIPTION', label: 'Opis działalności (kontekst dla AI)', type: 'textarea', placeholder: 'np. ośrodek agroturystyczny oferujący noclegi, SPA i przyjęcia okolicznościowe' },
    ],
  },
  {
    title: '⚙️ Ustawienia bota',
    fields: [
      { key: 'POLL_INTERVAL_MINUTES', label: 'Sprawdzaj skrzynkę co (minuty)', type: 'text', placeholder: '3' },
      { key: 'MAX_EMAILS_PER_CYCLE', label: 'Max maili na cykl', type: 'text', placeholder: '10' },
      { key: 'PROCESSED_FLAG', label: 'Flaga IMAP przetworzonych', type: 'text', placeholder: 'AI-Processed' },
      { key: 'PRICING_CSV_PATH', label: 'Ścieżka cennika CSV', type: 'text', placeholder: './data/cennik.csv' },
      { key: 'PRICING_NOTES_PATH', label: 'Ścieżka uwag do cennika', type: 'text', placeholder: './data/cennik-uwagi.txt' },
    ],
  },
  {
    title: '📊 Logi',
    fields: [
      { key: 'LOG_LEVEL', label: 'Poziom logowania', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error'] },
    ],
  },
];

// ── HTML ──────────────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #f7fafc; color: #2d3748; min-height: 100vh; }
a { color: #4299e1; text-decoration: none; }
header { background: #2d3748; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
header h1 { font-size: 1rem; font-weight: 600; opacity: .9; }
nav { display: flex; gap: 12px; align-items: center; }
nav a { color: #a0aec0; font-size: .85rem; }
nav a:hover { color: #fff; }
nav a.active { color: #fff; font-weight: 600; }
.badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(255,255,255,.1); border-radius: 20px; padding: 5px 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; }
.badge span { font-size: .8rem; font-weight: 700; letter-spacing: .05em; }
main { max-width: 700px; margin: 28px auto; padding: 0 16px 40px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
@media(max-width:480px) { .grid { grid-template-columns: 1fr; } }
.card { background: #fff; border-radius: 10px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
.card .label { font-size: .7rem; text-transform: uppercase; letter-spacing: .07em; color: #718096; margin-bottom: 5px; }
.card .value { font-size: 1.45rem; font-weight: 700; }
.card .sub { font-size: .75rem; color: #a0aec0; margin-top: 3px; }
.error-box { background: #fff5f5; border: 1px solid #fed7d7; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; }
.error-box .label { font-size: .7rem; text-transform: uppercase; color: #e53e3e; margin-bottom: 5px; }
.error-box .msg { font-size: .82rem; color: #742a2a; font-family: monospace; word-break: break-all; }
.success { background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; }
.success p { font-size: .88rem; color: #276749; }
.success code { font-size: .82rem; display: block; margin-top: 6px; background: #c6f6d5; padding: 6px 10px; border-radius: 6px; }
.login-wrap { max-width: 360px; margin: 80px auto 0; }
.login-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
.login-card h2 { font-size: 1.15rem; margin-bottom: 20px; color: #2d3748; }
.login-err { background: #fff5f5; color: #c53030; font-size: .85rem; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
.group { background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 20px; overflow: hidden; }
.group-title { font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #718096; padding: 14px 20px; border-bottom: 1px solid #e2e8f0; background: #f7fafc; }
.field { padding: 14px 20px; border-bottom: 1px solid #edf2f7; }
.field:last-child { border-bottom: none; }
.field label { display: block; font-size: .8rem; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
.field input, .field select, .field textarea { width: 100%; padding: 9px 12px; border: 1px solid #e2e8f0; border-radius: 7px; font-size: .88rem; color: #2d3748; background: #fff; transition: border-color .15s; }
.field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: #4299e1; box-shadow: 0 0 0 3px rgba(66,153,225,.15); }
.field textarea { resize: vertical; font-family: inherit; }
.field .hint { font-size: .73rem; color: #a0aec0; margin-top: 4px; }
.set-badge { font-size: .68rem; font-weight: 600; background: #ebf8ff; color: #2b6cb0; padding: 1px 7px; border-radius: 10px; vertical-align: middle; margin-left: 6px; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
button, .btn { padding: 10px 22px; border: none; border-radius: 8px; cursor: pointer; font-size: .88rem; font-weight: 600; transition: opacity .15s; }
button:hover, .btn:hover { opacity: .85; }
.btn-primary { background: #4299e1; color: #fff; }
.btn-danger { background: #fc8181; color: #fff; }
footer { text-align: center; font-size: .72rem; color: #a0aec0; margin-top: 24px; }
`;

function layout(title, body, { loggedIn = false, activePage = '' } = {}) {
  const color = stats.lastCycleStatus === 'error' ? '#e53e3e'
    : stats.lastCycleStatus === 'ok' ? '#38a169' : '#718096';
  const label = stats.lastCycleStatus === 'error' ? 'BŁĄD'
    : stats.lastCycleStatus === 'ok' ? 'DZIAŁA' : 'START';

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:16px">
    <h1>🌿 Bot ofertowy${process.env.COMPANY_NAME ? ` — ${process.env.COMPANY_NAME}` : ''}</h1>
    <div class="badge">
      <div class="dot" style="background:${color};box-shadow:0 0 6px ${color}"></div>
      <span style="color:${color}">${label}</span>
    </div>
  </div>
  <nav>
    <a href="/" class="${activePage === 'status' ? 'active' : ''}">Status</a>
    ${loggedIn ? `<a href="/settings" class="${activePage === 'settings' ? 'active' : ''}">Ustawienia</a>` : ''}
    ${loggedIn ? '<a href="/logout">Wyloguj</a>' : `<a href="/login" class="${activePage === 'login' ? 'active' : ''}">Zaloguj</a>`}
  </nav>
</header>
<main>${body}</main>
<footer>Bot ofertowy • odświeżanie co 30s</footer>
${activePage === 'status' ? '<script>setTimeout(()=>location.reload(),30000)</script>' : ''}
</body>
</html>`;
}

function timeAgo(date) {
  if (!date) return '—';
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s temu`;
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  return `${Math.floor(s / 3600)} godz. temu`;
}

function fmtDate(date) {
  if (!date) return '—';
  return date.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
}

function statusPage(loggedIn) {
  return layout('Bot — Status', `
  <div class="grid">
    <div class="card">
      <div class="label">Ostatni cykl</div>
      <div class="value">${timeAgo(stats.lastCycleAt)}</div>
      <div class="sub">${fmtDate(stats.lastCycleAt)}</div>
    </div>
    <div class="card">
      <div class="label">Czas cyklu</div>
      <div class="value">${stats.lastCycleDurationMs != null ? `${(stats.lastCycleDurationMs / 1000).toFixed(1)}s` : '—'}</div>
      <div class="sub">ostatni przebieg</div>
    </div>
    <div class="card">
      <div class="label">Maile przetworzone</div>
      <div class="value">${stats.emailsProcessed}</div>
      <div class="sub">od startu bota</div>
    </div>
    <div class="card">
      <div class="label">Cykle ukończone</div>
      <div class="value">${stats.cyclesTotal}</div>
      <div class="sub">działa od ${fmtDate(stats.startedAt)}</div>
    </div>
  </div>
  ${stats.lastError ? `<div class="error-box"><div class="label">Ostatni błąd</div><div class="msg">${stats.lastError.replace(/</g, '&lt;')}</div></div>` : ''}
  `, { loggedIn, activePage: 'status' });
}

function loginPage(error = '') {
  return layout('Logowanie', `
  <div class="login-wrap">
    <div class="login-card">
      <h2>🔐 Logowanie do panelu</h2>
      ${error ? `<div class="login-err">${error}</div>` : ''}
      <form method="POST" action="/login">
        <div class="field" style="padding:0;border:none">
          <label for="pw">Hasło</label>
          <input id="pw" type="password" name="password" autofocus autocomplete="current-password" style="margin-bottom:14px">
        </div>
        <button type="submit" class="btn-primary" style="width:100%">Zaloguj się</button>
      </form>
    </div>
  </div>
  `, { activePage: 'login' });
}

function renderField(field, currentVal) {
  const id = field.key.toLowerCase().replace(/_/g, '-');
  const isSet = Boolean(currentVal);

  if (field.type === 'select') {
    const opts = field.options.map(o =>
      `<option value="${o}"${currentVal === o ? ' selected' : ''}>${o}</option>`
    ).join('');
    return `<div class="field"><label for="${id}">${field.label}</label><select id="${id}" name="${field.key}">${opts}</select></div>`;
  }

  if (field.type === 'textarea') {
    const escaped = (currentVal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="field">
      <label for="${id}">${field.label}</label>
      <textarea id="${id}" name="${field.key}" rows="3" placeholder="${field.placeholder || ''}">${escaped}</textarea>
    </div>`;
  }

  if (field.sensitive) {
    return `<div class="field">
      <label for="${id}">${field.label}${isSet ? ' <span class="set-badge">ustawione</span>' : ''}</label>
      <input id="${id}" type="password" name="${field.key}" placeholder="${isSet ? '••••••••' : (field.placeholder || '')}" autocomplete="new-password">
      ${isSet ? '<p class="hint">Zostaw puste, aby zachować obecną wartość</p>' : ''}
    </div>`;
  }

  const escaped = (currentVal || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<div class="field">
    <label for="${id}">${field.label}</label>
    <input id="${id}" type="text" name="${field.key}" value="${escaped}" placeholder="${field.placeholder || ''}">
  </div>`;
}

async function settingsPage(message = '', isError = false) {
  const env = await readEnv();
  const groups = SETTINGS_GROUPS.map(g => `
    <div class="group">
      <div class="group-title">${g.title}</div>
      ${g.fields.map(f => renderField(f, env[f.key])).join('')}
    </div>`).join('');

  const notice = message ? (isError
    ? `<div class="error-box"><div class="label">Błąd</div><div class="msg">${message}</div></div>`
    : `<div class="success"><p>✅ ${message}</p><code>docker compose restart oferta-bot</code></div>`)
    : '';

  return layout('Ustawienia', `
  ${notice}
  <form method="POST" action="/settings">
    ${groups}
    <div class="actions">
      <button type="submit" class="btn-primary">Zapisz ustawienia</button>
    </div>
  </form>
  `, { loggedIn: true, activePage: 'settings' });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseForm(body) {
  return Object.fromEntries(
    body.split('&').map(p => p.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' '))))
  );
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
}

function html(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

// ── Router ────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - stats.startedAt) / 1000) }));
  }

  if (url === '/' && method === 'GET') {
    return html(res, statusPage(isAuth(req)));
  }

  if (url === '/login' && method === 'GET') {
    if (isAuth(req)) return redirect(res, '/settings');
    return html(res, loginPage());
  }

  if (url === '/login' && method === 'POST') {
    const form = parseForm(await readBody(req));
    if (form.password === ADMIN_PASSWORD) {
      setCookie(res, createToken());
      return redirect(res, '/settings');
    }
    return html(res, loginPage('Nieprawidłowe hasło'));
  }

  if (url === '/logout') {
    clearCookie(res);
    return redirect(res, '/');
  }

  if (url === '/settings') {
    if (!isAuth(req)) return redirect(res, '/login');
    if (method === 'GET') return html(res, await settingsPage());

    if (method === 'POST') {
      try {
        const form = parseForm(await readBody(req));
        // Filtrujemy puste wartości dla pól sensitive (zostawiamy istniejące)
        const env = await readEnv();
        const updates = {};
        for (const group of SETTINGS_GROUPS) {
          for (const field of group.fields) {
            const submitted = form[field.key];
            if (submitted === undefined) continue;
            if (field.sensitive && submitted === '') continue; // zachowaj istniejące
            updates[field.key] = submitted;
          }
        }
        await saveEnv(updates);
        return html(res, await settingsPage('Ustawienia zapisane. Uruchom restart kontenera, aby zastosować zmiany:'));
      } catch (err) {
        return html(res, await settingsPage(`Błąd zapisu: ${err.message}`, true));
      }
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ── Export ────────────────────────────────────────────────────────────────────

export function startStatusServer() {
  const port = parseInt(process.env.STATUS_PORT || '3000', 10);
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      logger.error({ err: err.message }, 'Status server błąd');
      res.writeHead(500);
      res.end('Internal error');
    });
  });
  server.listen(port, () => logger.info({ port }, 'Status server uruchomiony'));
  return server;
}
