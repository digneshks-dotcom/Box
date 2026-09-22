/**
 * L.J. Industries Cloud ERP — backend
 * ------------------------------------------------------------
 * - SQLite database (via better-sqlite3) for real persistence
 * - JWT authentication with bcrypt-hashed passwords
 * - A protected REST API the frontend (public/app.html) talks to
 * - Serves the frontend as static files
 *
 * Run `npm install` then `npm run init-admin` once to create the
 * first admin user, then `npm start`. See README.md for details.
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'erp.sqlite');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error(
    '\n[FATAL] JWT_SECRET is missing or too short.\n' +
    'Set a long random value in your .env file (see .env.example) before starting the server.\n'
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The app currently keeps its whole working state (companies, parties,
  -- boxes, reels, orders, etc.) as one JSON document, mirroring the shape
  -- the frontend already used in-memory. That's the fastest safe path to
  -- a real, persistent, authenticated backend. If/when multiple people
  -- need to edit concurrently at scale, split this into normalized
  -- tables (companies, parties, reels, orders, ...) with row-level
  -- writes — see the README for notes on that migration.
  CREATE TABLE IF NOT EXISTS app_data (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed default data on first run, matching the original demo dataset.
function defaultData() {
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const mill1 = uid(), comp1 = uid(), comp2 = uid(), b1 = uid();
  return {
    companies: [
      { id: comp1, name: 'Morbi Ceramic Box Co.', gstin: '24ABCDE1234F1Z5', phone: '98250 00000', address: 'Morbi, Gujarat' },
      { id: comp2, name: 'Prime Carton Industries', gstin: '24XYZDE1234F1Z5', phone: '98251 11111', address: 'Rajkot' }
    ],
    parties: [
      { id: mill1, name: 'NEXA PAPER MILL', type: 'Supplier', contact: '99000 22233' },
      { id: uid(), name: 'APOLLO PAPER', type: 'Supplier', contact: '99000 11122' }
    ],
    materials: [
      { id: uid(), name: '180 GSM Kraft', category: 'Raw' },
      { id: uid(), name: '48/120/16 Duplex', category: 'Raw' }
    ],
    zones: [{ id: uid(), name: 'A' }, { id: uid(), name: 'B' }],
    boxes: [
      { id: b1, srNo: 1, companyId: comp1, boxName: '600x1200 Porcelain Carton', boxType: 'Master Carton', l: 48, w: 24, h: 12, unit: 'inch', ply: 5, deckle: 39, cutting: 41.75, boxInSheet: 0.5, weight: 492, savedRate: 100.76, topPaper: '180 GSM Kraft', flutePaper: '140 GSM Fluting', bottomPaper: '180 GSM Kraft' },
      { id: uid(), srNo: 2, companyId: comp2, boxName: 'Cartoon 24x18', boxType: 'Cartoon', l: 24, w: 18, h: 10, unit: 'inch', ply: 5, deckle: 328, cutting: 1543, boxInSheet: 0.5, weight: 1518, savedRate: 85.5, topPaper: '150 GSM Kraft', flutePaper: '140 GSM Fluting', bottomPaper: '150 GSM Kraft' }
    ],
    reels: [
      { id: uid(), reelNo: 'C3', zoneId: '', paperName: '48/120/16 Duplex', millId: mill1, millReelNo: 'M123', shade: 'Golden', rateKg: 37, quality: 'OK', weightIn: 349, weightBalance: 349, dateIn: today(), remark: '' },
      { id: uid(), reelNo: 'C4', zoneId: '', paperName: '180 GSM Kraft', millId: mill1, millReelNo: 'M124', shade: 'AP GO', rateKg: 36, quality: 'OK', weightIn: 591, weightBalance: 591, dateIn: today(), remark: '' }
    ],
    paperOutLog: [],
    orders: [{ id: uid(), poNo: 'PO-1000', date: today(), dispatchDate: null, companyId: comp1, boxId: b1, qty: 5000, price: 100.76, status: 'Received' }],
    settings: { nextBoxSr: 3, nextReelSr: 100, nextOrderNo: 1001 }
  };
}

const existingRow = db.prepare('SELECT id FROM app_data WHERE id = 1').get();
if (!existingRow) {
  db.prepare('INSERT INTO app_data (id, data) VALUES (1, ?)').run(JSON.stringify(defaultData()));
}

/* ------------------------------------------------------------------ */
/* App setup                                                           */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // the frontend is a single inline-script HTML file
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '5mb' })); // the whole app_data blob is sent on every save

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

/* ------------------------------------------------------------------ */
/* Auth helpers                                                        */
/* ------------------------------------------------------------------ */
function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const bcrypt = require('bcryptjs');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({ token, user: { username: user.username, role: user.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/api/data', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM app_data WHERE id = 1').get();
  res.json(JSON.parse(row.data));
});

app.put('/api/data', requireAuth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  db.prepare("UPDATE app_data SET data = ?, updated_at = datetime('now') WHERE id = 1")
    .run(JSON.stringify(body));
  res.status(204).end();
});

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => {
  console.log(`L.J. Industries ERP backend listening on port ${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
