// One-time manual migration: seeds an EmployeeSalaryHistory row for every employee that
// doesn't have one yet, from their legacy flat baseSalary/salary field. Not run
// automatically on server boot — the payroll engine already falls back to baseSalary on
// its own (see resolveSalaryStructure in src/payrollCalculator.js), so this script only
// exists to get employees into *visible* history for the new Employee Profile UI; it is
// never required for correctness.
//
// Usage: node scripts/backfill-salary-history.js
const prisma = require('../src/prisma');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const employees = await prisma.employee.findMany();
  const existingHistory = await prisma.employeeSalaryHistory.findMany();
  const employeeIdsWithHistory = new Set(existingHistory.map(row => String(row.employeeId)));

  let seeded = 0;
  let skipped = 0;

  for (const employee of employees) {
    if (employeeIdsWithHistory.has(String(employee.id))) {
      skipped++;
      continue;
    }
    const basic = number(employee.baseSalary, number(employee.salary));
    await prisma.employeeSalaryHistory.create({
      data: {
        id: String(Date.now() + Math.random()),
        employeeId: String(employee.id),
        effectiveFrom: employee.dateOfJoining || '1970-01-01',
        basic,
        hra: 0, conveyance: 0, specialAllowance: 0, otherAllowance: 0,
        bonus: 0, incentive: 0, otherEarnings: 0,
        tax: 0, loan: 0, advance: 0, otherDeduction: 0,
        note: 'Auto-seeded from legacy baseSalary',
        createdBy: 'system-migration',
        createdAt: new Date().toISOString(),
      },
    });
    seeded++;
  }

  console.log(`Seeded ${seeded} employee(s), skipped ${skipped} (already had salary history).`);
  await prisma.$disconnect();
}

main().catch(async error => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
