// One-time manual migration: copies the old generic Setting{category:'salaryComponent'}
// rows (the cosmetic, non-effective-dated global component list that predates this
// phase) into the new StatutoryComponent model, so Settings > Salary Structure shows
// continuity instead of an empty list after the frontend cut-over. Old Setting rows are
// left untouched — nothing reads them anymore (see public/index.html's Salary Structure
// tab, now wired to /api/statutory-components), so leaving them is harmless.
//
// Usage: node scripts/migrate-statutory-components.js
const prisma = require('../src/prisma');

async function main() {
  const legacyRows = await prisma.setting.findMany({ where: { category: 'salaryComponent' } });
  const existingComponents = await prisma.statutoryComponent.findMany();
  const seenNames = new Set(existingComponents.map(row => row.name));

  let migrated = 0;
  let skipped = 0;

  for (const row of legacyRows) {
    // The legacy Setting collection had real duplicate rows (same name inserted more than
    // once by an earlier seed) — dedupe by name as we go, not just against what already
    // existed in StatutoryComponent, or a duplicated Deduction would get double-applied
    // every payroll run (e.g. two "Provident Fund" rows stacking into 24% instead of 12%).
    if (seenNames.has(row.name)) {
      skipped++;
      continue;
    }
    seenNames.add(row.name);
    const values = row.values || {};
    await prisma.statutoryComponent.create({
      data: {
        id: String(Date.now() + Math.random()),
        componentKey: String(Date.now() + Math.random()),
        name: row.name,
        type: values.type || 'Deduction',
        calcType: values.calcType || 'Fixed',
        value: Number(values.value) || 0,
        effectiveFrom: null,
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    });
    migrated++;
  }

  console.log(`Migrated ${migrated} statutory component(s), skipped ${skipped} (name already present).`);
  await prisma.$disconnect();
}

main().catch(async error => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
