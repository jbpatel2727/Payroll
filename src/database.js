const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const DATA_FILE = path.join(__dirname, 'data.json');
const LOCAL_DB_FILE = path.join(__dirname, 'payroll.sqlite');

function initDatabase() {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
  let dbPath = LOCAL_DB_FILE;

  if (isServerless) {
    dbPath = path.join(os.tmpdir(), 'payroll.sqlite');
    if (!fs.existsSync(dbPath) && fs.existsSync(LOCAL_DB_FILE)) {
      try {
        fs.copyFileSync(LOCAL_DB_FILE, dbPath);
      } catch (err) {
        console.warn('Could not copy bundled payroll.sqlite to /tmp:', err.message);
      }
    }
  }

  try {
    return { db: new DatabaseSync(dbPath), dbPath };
  } catch (err) {
    // If opening the local file fails with read-only filesystem or any error, fallback to /tmp
    if (dbPath !== path.join(os.tmpdir(), 'payroll.sqlite')) {
      const fallbackPath = path.join(os.tmpdir(), 'payroll.sqlite');
      try {
        if (fs.existsSync(LOCAL_DB_FILE)) fs.copyFileSync(LOCAL_DB_FILE, fallbackPath);
      } catch (_) {}
      return { db: new DatabaseSync(fallbackPath), dbPath: fallbackPath };
    }
    throw err;
  }
}

const { db: database, dbPath: DB_FILE } = initDatabase();

database.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`);

const collections = ['branches', 'departments', 'employees', 'attendance', 'payroll', 'transfers', 'payrollRuns', 'expenses', 'settings', 'authUsers'];
const insertCollection = database.prepare('INSERT OR IGNORE INTO collections (name, data) VALUES (?, ?)');
const readCollection = database.prepare('SELECT data FROM collections WHERE name = ?');
const writeCollection = database.prepare('UPDATE collections SET data = ? WHERE name = ?');

let tursoClient = null;
if (process.env.TURSO_DATABASE_URL) {
  try {
    const { createClient } = require('@libsql/client');
    tursoClient = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
    // Ensure table exists on Turso and hydrate local cache
    tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS collections (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `).then(async () => {
      const res = await tursoClient.execute('SELECT name, data FROM collections');
      if (res.rows && res.rows.length > 0) {
        res.rows.forEach(row => {
          try {
            writeCollection.run(String(row.data), String(row.name));
          } catch (_) {}
        });
      }
    }).catch(err => console.warn('Turso initialization warning:', err.message));
  } catch (err) {
    console.warn('Could not load @libsql/client:', err.message);
  }
}

function seedFromJson() {
  let source = {};
  if (fs.existsSync(DATA_FILE)) source = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  collections.forEach(name => insertCollection.run(name, JSON.stringify(Array.isArray(source[name]) ? source[name] : [])));
}

seedFromJson();

function loadDatabase() {
  return Object.fromEntries(collections.map(name => {
    const row = readCollection.get(name);
    return [name, row ? JSON.parse(row.data) : []];
  }));
}

function saveDatabase(data) {
  collections.forEach(name => writeCollection.run(JSON.stringify(Array.isArray(data[name]) ? data[name] : []), name));
  if (tursoClient) {
    Promise.all(collections.map(name => {
      const payload = JSON.stringify(Array.isArray(data[name]) ? data[name] : []);
      return tursoClient.execute({
        sql: 'INSERT INTO collections (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data',
        args: [name, payload]
      });
    })).catch(err => console.error('Turso background sync error:', err.message));
  }
}

module.exports = { loadDatabase, saveDatabase, DB_FILE };
