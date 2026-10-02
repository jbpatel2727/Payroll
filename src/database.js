// Business data (branches, departments, employees, attendance, payroll, transfers,
// expenses, settings) lives in MongoDB via Prisma — see prisma/schema.prisma for the
// models. This module preserves the old JSON-blob interface (loadDatabase() returns
// every collection as a plain object of arrays; saveDatabase()/saveCollection() write
// them back) so the route handlers in src/server.js keep their existing shape and
// business logic; only the underlying storage changed.
const prisma = require('./prisma');

const COLLECTION_MODEL = {
  branches: 'branch',
  departments: 'department',
  employees: 'employee',
  attendance: 'attendance',
  payroll: 'payrollRecord',
  transfers: 'transfer',
  payrollRuns: 'payrollRun',
  expenses: 'expense',
  settings: 'setting',
  employeeSalaryHistory: 'employeeSalaryHistory',
  statutoryComponents: 'statutoryComponent',
};

const COLLECTIONS = Object.keys(COLLECTION_MODEL);

// Settings use a real auto-generated ObjectId (existing data had colliding legacy ids
// across categories), so they're excluded from the generic string-id write path.
const AUTO_ID_COLLECTIONS = new Set(['settings']);

async function loadDatabase() {
  const entries = await Promise.all(
    COLLECTIONS.map(async key => [key, await prisma[COLLECTION_MODEL[key]].findMany()])
  );
  return Object.fromEntries(entries);
}

async function saveCollection(key, items) {
  const model = COLLECTION_MODEL[key];
  if (!model) throw new Error(`Unknown collection: ${key}`);
  const rows = Array.isArray(items) ? items : [];
  await prisma[model].deleteMany({});
  if (!rows.length) return;
  if (AUTO_ID_COLLECTIONS.has(key)) {
    for (const row of rows) {
      const { id, ...rest } = row;
      await prisma[model].create({ data: rest });
    }
  } else {
    await prisma[model].createMany({ data: rows.map(row => ({ ...row, id: String(row.id) })) });
  }
}

async function saveDatabase(data) {
  await Promise.all(
    COLLECTIONS.filter(key => Array.isArray(data[key])).map(key => saveCollection(key, data[key]))
  );
}

module.exports = { loadDatabase, saveDatabase, saveCollection };
