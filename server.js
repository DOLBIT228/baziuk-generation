import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, pbkdf2Sync, timingSafeEqual, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const DB_FILE = join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 3000);
const OPENROUTER_MODEL = 'google/gemini-3-pro-image-preview';
const USD_UAH_RATE = Number(process.env.USD_UAH_RATE || 40);
const INPUT_PRICE_PER_M = Number(process.env.MODEL_INPUT_PRICE_PER_MILLION || 2);
const OUTPUT_PRICE_PER_M = Number(process.env.MODEL_OUTPUT_PRICE_PER_MILLION || 12);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEFAULT_STYLES = ['Комерційний банер', 'Реалістична фотографія', 'Мінімалістичний UI', '3D ілюстрація', 'Кінематографічний'];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function ensureStorage() {
  await mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await stat(DB_FILE);
  } catch {
    const admin = createUserRecord(ADMIN_USERNAME, ADMIN_PASSWORD, 'admin');
    await writeJson(DB_FILE, { users: [admin], generations: [], sessions: [], settings: { styles: DEFAULT_STYLES } });
  }
}

async function readDb() {
  await ensureStorage();
  const db = JSON.parse(await readFile(DB_FILE, 'utf8'));
  db.users ||= [];
  db.generations ||= [];
  db.sessions ||= [];
  db.settings ||= {};
  db.settings.styles = Array.isArray(db.settings.styles) && db.settings.styles.length ? db.settings.styles : DEFAULT_STYLES;
  return db;
}

async function writeDb(db) {
  await writeJson(DB_FILE, db);
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}

function createUserRecord(username, password, role = 'user') {
  const salt = randomBytes(16).toString('hex');
  return {
    id: randomId('usr'),
    username: username.trim(),
    passwordHash: hashPassword(password, salt),
    salt,
    role,
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex');
}

function verifyPassword(password, user) {
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function sign(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function sessionCookie(sessionId) {
  return `sid=${sessionId}.${sign(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((cookie) => {
    const [key, ...rest] = cookie.trim().split('=');
    return [key, decodeURIComponent(rest.join('='))];
  }));
}

async function getCurrentUser(req) {
  const raw = parseCookies(req).sid;
  if (!raw) return null;
  const [id, signature] = raw.split('.');
  if (!id || signature !== sign(id)) return null;
  const db = await readDb();
  const session = db.sessions.find((item) => item.id === id && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId && user.active) || null;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicUser(user) {
  return user ? { id: user.id, username: user.username, role: user.role, active: user.active } : null;
}

function costFromUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const totalUsd = (inputTokens / 1_000_000) * INPUT_PRICE_PER_M + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
  return {
    inputTokens,
    outputTokens,
    usd: Number(totalUsd.toFixed(6)),
    uah: Number((totalUsd * USD_UAH_RATE).toFixed(2)),
    usdUahRate: USD_UAH_RATE,
  };
}

function buildPrompt({ prompt, aspectRatio, imageSize, style }) {
  const parts = [prompt.trim()];
  if (style) parts.push(`Стиль: ${style}.`);
  parts.push(`Згенеруй професійний візуал зі співвідношенням сторін ${aspectRatio} та якістю ${imageSize}.`);
  return parts.join('\n');
}

async function callOpenRouter({ prompt, aspectRatio, imageSize, referenceImageUrls = [] }) {
  if (!process.env.OPENROUTER_API_KEY) {
    return mockGeneration({ prompt, aspectRatio, imageSize });
  }

  const content = referenceImageUrls.length
    ? [
        { type: 'text', text: `${prompt}\nВикористай прикріплені зображення як контекст: поточний візуал чату та/або додані референси. Внеси описані правки або обʼєднай візуали згідно із промтом.` },
        ...referenceImageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : prompt;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': process.env.APP_TITLE || 'Baziuk Generation',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      image_config: {
        aspect_ratio: aspectRatio,
        image_size: imageSize,
      },
      stream: false,
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.error?.message || `OpenRouter request failed: ${response.status}`);
  }

  const message = result.choices?.[0]?.message || {};
  const imageDataUrl = message.images?.[0]?.image_url?.url || extractDataUrl(message.content);
  if (!imageDataUrl) {
    throw new Error('Модель не повернула зображення. Спробуйте уточнити промт або перевірте доступність моделі.');
  }

  return {
    dataUrl: imageDataUrl,
    model: result.model || OPENROUTER_MODEL,
    cost: costFromUsage(result.usage),
    providerMessage: typeof message.content === 'string' ? message.content : '',
    rawUsage: result.usage || {},
    mocked: false,
  };
}

function isDataUrl(value) {
  return typeof value === 'string' && /^data:image\/[\w.+-]+;base64,/.test(value);
}

function extractDataUrl(content) {
  if (typeof content !== 'string') return null;
  return content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/)?.[0] || null;
}

async function mockGeneration({ prompt, aspectRatio, imageSize }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#64748b"/></linearGradient></defs><rect width="1024" height="1024" rx="56" fill="url(#g)"/><circle cx="790" cy="210" r="120" fill="#ffffff" opacity=".12"/><circle cx="240" cy="740" r="180" fill="#ffffff" opacity=".08"/><text x="72" y="116" fill="#fff" font-family="Arial" font-size="42" font-weight="700">Baziuk Generation</text><text x="72" y="184" fill="#e5e7eb" font-family="Arial" font-size="26">${escapeXml(aspectRatio)} · ${escapeXml(imageSize)}</text><foreignObject x="72" y="300" width="880" height="360"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;color:white;font-size:34px;line-height:1.25;font-weight:700;">${escapeXml(prompt).slice(0, 220)}</div></foreignObject><text x="72" y="930" fill="#d1d5db" font-family="Arial" font-size="24">Mock mode: додайте OPENROUTER_API_KEY для реальної генерації</text></svg>`;
  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    model: `${OPENROUTER_MODEL} (mock)`,
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, uah: 0, usdUahRate: USD_UAH_RATE },
    providerMessage: 'Mock image generated locally because OPENROUTER_API_KEY is not configured.',
    rawUsage: {},
    mocked: true,
  };
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]));
}

async function saveDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!match) throw new Error('Unsupported image format');
  const extension = match[1].split('/')[1].replace('svg+xml', 'svg');
  const filename = `${randomId('img')}.${extension}`;
  await writeFile(join(UPLOAD_DIR, filename), Buffer.from(match[2], 'base64'));
  return `/uploads/${filename}`;
}

async function dataUrlFromPublicPath(publicPath) {
  if (isDataUrl(publicPath)) return publicPath;
  const safePath = normalize(publicPath.replace(/^\/+/, ''));
  if (!safePath.startsWith('uploads/')) throw new Error('Invalid reference image path');
  const fullPath = join(DATA_DIR, safePath);
  const buffer = await readFile(fullPath);
  const mime = mimeTypes[extname(fullPath)] || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function handleApi(req, res, path) {
  const user = await getCurrentUser(req);

  if (path === '/api/health') return sendJson(res, 200, { ok: true });

  if (path === '/api/login' && req.method === 'POST') {
    const { username = '', password = '' } = await readBody(req);
    const db = await readDb();
    const found = db.users.find((item) => item.username === username && item.active);
    if (!found || !verifyPassword(password, found)) return sendError(res, 401, 'Невірний логін або пароль');
    const session = { id: randomId('ses'), userId: found.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 24 * 14 * 1000).toISOString() };
    db.sessions.push(session);
    await writeDb(db);
    return sendJson(res, 200, { user: publicUser(found) }, { 'Set-Cookie': sessionCookie(session.id) });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    const raw = parseCookies(req).sid;
    if (raw) {
      const [id] = raw.split('.');
      const db = await readDb();
      db.sessions = db.sessions.filter((session) => session.id !== id);
      await writeDb(db);
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  if (path === '/api/me') return sendJson(res, 200, { user: publicUser(user) });

  if (path === '/api/settings' && req.method === 'GET') {
    const db = await readDb();
    return sendJson(res, 200, { styles: db.settings.styles });
  }

  if (!user) return sendError(res, 401, 'Потрібно увійти в систему');

  if (path === '/api/generate' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.prompt || body.prompt.trim().length < 3) return sendError(res, 400, 'Опишіть зображення детальніше');
    const aspectRatio = body.aspectRatio || '1:1';
    const imageSize = body.imageSize || '1K';
    const prompt = buildPrompt({ prompt: body.prompt, aspectRatio, imageSize, style: body.style });
    const requestedReferences = [body.referenceImage, ...(Array.isArray(body.referenceImages) ? body.referenceImages : [])].filter(Boolean).slice(0, 3);
    const referenceImageUrls = [];
    for (const reference of requestedReferences) referenceImageUrls.push(await dataUrlFromPublicPath(reference));
    const generated = await callOpenRouter({ prompt, aspectRatio, imageSize, referenceImageUrls });
    const imageUrl = await saveDataUrl(generated.dataUrl);
    const record = {
      id: randomId('gen'),
      userId: user.id,
      username: user.username,
      prompt: body.prompt,
      chatId: body.chatId || randomId('chat'),
      chatTitle: body.chatTitle || body.prompt.slice(0, 64),
      normalizedPrompt: prompt,
      aspectRatio,
      imageSize,
      style: body.style || '',
      imageUrl,
      referenceImage: body.referenceImage || null,
      referenceImagesCount: requestedReferences.length,
      model: generated.model,
      cost: generated.cost,
      providerMessage: generated.providerMessage,
      mocked: generated.mocked,
      createdAt: new Date().toISOString(),
    };
    const db = await readDb();
    db.generations.unshift(record);
    await writeDb(db);
    return sendJson(res, 201, { generation: record });
  }

  if (path === '/api/gallery' && req.method === 'GET') {
    const db = await readDb();
    const items = user.role === 'admin' ? db.generations : db.generations.filter((item) => item.userId === user.id);
    return sendJson(res, 200, { generations: items });
  }

  if (path === '/api/admin/users' && user.role === 'admin') {
    const db = await readDb();
    if (req.method === 'GET') return sendJson(res, 200, { users: db.users.map(publicUser) });
    if (req.method === 'POST') {
      const { username = '', password = '', role = 'user' } = await readBody(req);
      if (username.trim().length < 3 || password.length < 6) return sendError(res, 400, 'Логін від 3 символів, пароль від 6 символів');
      if (db.users.some((item) => item.username === username.trim())) return sendError(res, 409, 'Такий користувач вже існує');
      const created = createUserRecord(username, password, role === 'admin' ? 'admin' : 'user');
      db.users.push(created);
      await writeDb(db);
      return sendJson(res, 201, { user: publicUser(created) });
    }
  }

  if (path === '/api/admin/styles' && user.role === 'admin' && req.method === 'PUT') {
    const body = await readBody(req);
    const styles = Array.isArray(body.styles) ? body.styles.map((item) => String(item).trim()).filter(Boolean).slice(0, 60) : [];
    if (!styles.length) return sendError(res, 400, 'Додайте хоча б один стиль');
    const db = await readDb();
    db.settings.styles = [...new Set(styles)];
    await writeDb(db);
    return sendJson(res, 200, { styles: db.settings.styles });
  }

  if (path.startsWith('/api/admin/users/') && user.role === 'admin' && req.method === 'PATCH') {
    const id = decodeURIComponent(path.split('/').pop());
    const body = await readBody(req);
    const db = await readDb();
    const target = db.users.find((item) => item.id === id);
    if (!target) return sendError(res, 404, 'Користувача не знайдено');
    if (typeof body.active === 'boolean') target.active = body.active;
    if (body.password) {
      target.salt = randomBytes(16).toString('hex');
      target.passwordHash = hashPassword(body.password, target.salt);
    }
    await writeDb(db);
    return sendJson(res, 200, { user: publicUser(target) });
  }

  sendError(res, 404, 'Not found');
}

async function serveStatic(req, res, pathname) {
  const path = pathname === '/' ? '/index.html' : pathname;
  const baseDir = path.startsWith('/uploads/') ? DATA_DIR : PUBLIC_DIR;
  const safePath = normalize(path).replace(/^([.][.][/\\])+/, '').replace(/^\/+/, '');
  const fullPath = join(baseDir, safePath);
  if (!fullPath.startsWith(baseDir)) return sendError(res, 403, 'Forbidden');
  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(fullPath)] || 'application/octet-stream' });
    createReadStream(fullPath).pipe(res);
  } catch {
    const fallback = join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(fallback).pipe(res);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || 'Server error');
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await ensureStorage();
  server.listen(PORT, () => {
    console.log(`Baziuk Generation is running on http://localhost:${PORT}`);
    if (!process.env.OPENROUTER_API_KEY) console.log('OPENROUTER_API_KEY is not set: mock generation mode is enabled.');
  });
}

export { buildPrompt, costFromUsage, createUserRecord, verifyPassword, extractDataUrl, isDataUrl };
