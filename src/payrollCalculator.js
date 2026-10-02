// Centralized attendance-based payroll calculation engine. Pure functions only — no
// database access, no req/res — so the math can be unit-tested and reused anywhere
// (the /api/payroll/generate route is the only caller today, but this keeps it that way
// on purpose). Preserves the original branch-transfer-split logic that lived inline in
// src/server.js (source-branch/target-branch days around a mid-month Transfer) exactly;
// it just feeds that logic a richer, itemized salary structure instead of one flat number.

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const RECURRING_FIELDS = ['basic', 'hra', 'conveyance', 'specialAllowance', 'otherAllowance'];
const ONE_TIME_EARNING_FIELDS = ['bonus', 'incentive', 'otherEarnings'];
const FLAT_DEDUCTION_FIELDS = ['tax', 'loan', 'advance', 'otherDeduction'];

// A date string "YYYY-MM-31" that any real date within `month` sorts at-or-before,
// used for simple lexicographic "is this effective by the end of this month" checks.
function monthEndKey(month) {
  return `${month}-31`;
}

// Picks the latest salary-history row for this employee whose effectiveFrom is on or
// before the end of `month`. Returns null if the employee has no history yet (caller
// is responsible for the legacy baseSalary fallback — see src/server.js).
function resolveSalaryStructure(historyRows, employeeId, month) {
  const endKey = monthEndKey(month);
  const candidates = (historyRows || [])
    .filter(row => String(row.employeeId) === String(employeeId) && row.effectiveFrom && row.effectiveFrom <= endKey)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] || null;
}

// Picks, per componentKey, the latest active Deduction-type version effective by the
// end of `month`. Editing a component inserts a new row (never mutates), so this is
// what makes already-generated months immune to later rate changes.
function resolveStatutoryComponents(componentRows, month) {
  const endKey = monthEndKey(month);
  const latestByKey = new Map();
  (componentRows || []).forEach(row => {
    if (!row.componentKey) return;
    const effectiveFrom = row.effectiveFrom || '';
    if (effectiveFrom > endKey) return;
    const existing = latestByKey.get(row.componentKey);
    if (!existing || effectiveFrom >= (existing.effectiveFrom || '')) {
      latestByKey.set(row.componentKey, row);
    }
  });
  return Array.from(latestByKey.values()).filter(row => row.isActive !== false && row.type === 'Deduction');
}

// calcMethod: 'workingDays' (Mon-Fri count, default) | 'calendarDays' (every day) |
// 'attendanceDays' (caller-supplied count — per-employee, since it varies by employee).
function getTotalWorkingDays(month, calcMethod, workingDaysOverride, attendanceDayCount) {
  if (workingDaysOverride !== undefined && workingDaysOverride !== null && workingDaysOverride !== '') {
    return number(workingDaysOverride);
  }
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  if (calcMethod === 'calendarDays') return daysInMonth;
  if (calcMethod === 'attendanceDays') return Math.max(1, number(attendanceDayCount, daysInMonth));
  return Array.from({ length: daysInMonth }, (_, index) => new Date(year, monthIndex, index + 1).getDay())
    .filter(day => day !== 0 && day !== 6).length;
}

// Extracted verbatim from the original inline closure in src/server.js.
function summarizeAttendance(records) {
  const worked = records.reduce((sum, record) => sum + number(record.daysWorked, record.status === 'Present' ? 1 : record.status === 'Half Day' ? 0.5 : 0), 0);
  const paidLeave = records.reduce((sum, record) => sum + number(record.paidLeave), 0);
  const holidays = records.reduce((sum, record) => sum + number(record.gazettedHoliday), 0);
  const lwp = records.reduce((sum, record) => sum + number(record.unpaidLeave) + (record.status === 'Absent' ? 1 : 0), 0);
  const overtimeHours = records.reduce((sum, record) => sum + number(record.overtimeHours || record.extraHours), 0);
  return { worked, paidLeave, holidays, lwp, overtimeHours };
}

// Keeps only the most recently-added attendance record per date for an employee/month.
// Returns the deduped list plus the dates that had duplicates, so the caller can log a
// non-blocking exception instead of silently double/under-counting payable days.
function dedupeAttendanceByDate(records) {
  const byDate = new Map();
  const duplicateDates = new Set();
  records.forEach(record => {
    if (byDate.has(record.date)) duplicateDates.add(record.date);
    byDate.set(record.date, record);
  });
  return { deduped: Array.from(byDate.values()), duplicateDates: Array.from(duplicateDates) };
}

// The engine. `salaryStructure` is a resolved EmployeeSalaryHistory-shaped row (or a
// synthetic legacy fallback — see src/server.js). `attendance` is this employee's
// already-deduped, already-month-filtered Attendance rows. `transfer` is the Transfer
// effective this month, if any (same as today's getEmployeeTransfer()).
function calculateEmployeePayroll({ employee, salaryStructure, statutoryComponents, attendance, transfer, month, totalWorkingDays, overtimeMultiplier, gazettedHolidays }) {
  const exceptions = [];
  const structure = salaryStructure || {};
  const recurringMonthlyTotal = RECURRING_FIELDS.reduce((sum, key) => sum + number(structure[key]), 0);
  const perDayRate = recurringMonthlyTotal / Math.max(totalWorkingDays, 1);

  if (!attendance.length) exceptions.push({ type: 'Missing attendance', message: `${employee.name} (${employee.empCode || employee.id}) has no attendance records for ${month}`, employeeId: employee.id });
  if (transfer && transfer.status !== 'Approved') exceptions.push({ type: 'Unapproved transfer', message: `${employee.name} (${employee.empCode || employee.id}) has an unapproved transfer`, employeeId: employee.id });

  const transferDate = transfer?.effectiveDate;
  const sourceRecords = attendance.filter(record => !transferDate || record.date < transferDate);
  const targetRecords = transfer ? attendance.filter(record => record.date >= transferDate) : [];
  const source = summarizeAttendance(sourceRecords);
  const target = summarizeAttendance(targetRecords);

  const payableDays = source.worked + source.paidLeave + source.holidays + target.worked + target.paidLeave + target.holidays + number(gazettedHolidays);
  const lopDays = Math.max(0, totalWorkingDays - payableDays);
  const sourceDays = transfer ? Math.max(0, Math.round((new Date(transferDate) - new Date(`${month}-01`)) / 86400000)) : totalWorkingDays;
  const targetDays = transfer ? totalWorkingDays - sourceDays : 0;
  const holidaySource = transfer ? Math.min(number(gazettedHolidays), sourceDays) : number(gazettedHolidays);
  const holidayTarget = transfer ? Math.max(0, number(gazettedHolidays) - holidaySource) : 0;
  const sourcePayableCap = source.worked + source.paidLeave + source.holidays + holidaySource;
  const targetPayableCap = target.worked + target.paidLeave + target.holidays + holidayTarget;

  const sourceGross = Math.round(perDayRate * Math.min(sourceDays, sourcePayableCap));
  const targetGross = Math.round(perDayRate * Math.min(targetDays, targetPayableCap));

  // Itemize each recurring component using the same per-day-rate/proration formula as
  // sourceGross/targetGross above, so the five components sum back to that total.
  const earningsBreakdown = {};
  RECURRING_FIELDS.forEach(key => {
    const componentPerDayRate = number(structure[key]) / Math.max(totalWorkingDays, 1);
    const componentSource = Math.round(componentPerDayRate * Math.min(sourceDays, sourcePayableCap));
    const componentTarget = Math.round(componentPerDayRate * Math.min(targetDays, targetPayableCap));
    earningsBreakdown[key] = componentSource + componentTarget;
  });

  const relocation = transfer ? number(transfer.relocationAllowance) : 0;
  const salaryRevision = transfer ? number(transfer.salaryRevision) : 0;
  const overtimeHours = source.overtimeHours + target.overtimeHours;
  const hourlyRate = perDayRate / 8;
  const overtimePay = Math.round(overtimeHours * hourlyRate * number(overtimeMultiplier, 1.5));
  const lopDeduction = Math.round(lopDays * perDayRate);

  const bonus = number(structure.bonus);
  const incentive = number(structure.incentive);
  const otherEarnings = number(structure.otherEarnings);
  const tax = number(structure.tax);
  const loan = number(structure.loan);
  const advance = number(structure.advance);
  const otherDeduction = number(structure.otherDeduction);

  const statutoryDeductionBreakdown = (statutoryComponents || []).map(component => ({
    name: component.name,
    amount: Math.round(component.calcType === 'Percentage' ? number(structure.basic) * number(component.value) / 100 : number(component.value)),
  }));
  const statutoryTotal = statutoryDeductionBreakdown.reduce((sum, item) => sum + item.amount, 0);

  const grossPay = sourceGross + targetGross + overtimePay + relocation + salaryRevision + bonus + incentive + otherEarnings;
  const deductions = lopDeduction + statutoryTotal + tax + loan + advance + otherDeduction;
  const netPay = Math.max(0, grossPay - deductions);

  if (grossPay - deductions < 0) exceptions.push({ type: 'Negative net pay', message: `${employee.name} (${employee.empCode || employee.id}) calculated a negative net pay`, employeeId: employee.id });
  if (transfer && !sourceRecords.length) exceptions.push({ type: 'Missing source attendance', message: `${employee.name} (${employee.empCode || employee.id}) has no source-branch attendance before ${transfer.effectiveDate}`, employeeId: employee.id });
  if (transfer && !targetRecords.length) exceptions.push({ type: 'Missing target attendance', message: `${employee.name} (${employee.empCode || employee.id}) has no target-branch attendance from ${transfer.effectiveDate}`, employeeId: employee.id });

  return {
    empId: employee.id, empName: employee.name, empCode: employee.empCode || '', month,
    sourceBranch: transfer?.sourceBranch || employee.branchCode || '-', targetBranch: transfer?.targetBranch || employee.branchCode || '-',
    transferDate: transfer?.effectiveDate || '',
    daysSource: source.worked + source.paidLeave + source.holidays, daysTarget: target.worked + target.paidLeave + target.holidays,
    totalWorkingDays, payableDays, lopDays, baseSalary: recurringMonthlyTotal, sourceGross, targetGross,
    hra: earningsBreakdown.hra, conveyance: earningsBreakdown.conveyance, specialAllowance: earningsBreakdown.specialAllowance, otherAllowance: earningsBreakdown.otherAllowance,
    bonus, incentive, otherEarnings, tax, loan, advance, otherDeduction,
    overtimeHours, overtimePay, relocationAllowance: relocation, salaryRevision, grossPay, deductions,
    lopDeduction, statutoryDeductions: statutoryTotal, statutoryDeductionBreakdown, netPay, netSalary: netPay,
    salaryStructureId: structure.id || null,
    branchAllocation: [
      { branch: transfer?.sourceBranch || employee.branchCode || '-', amount: sourceGross },
      ...(transfer ? [{ branch: transfer.targetBranch, amount: targetGross + relocation + salaryRevision }] : []),
    ],
    exceptions,
  };
}

module.exports = {
  number,
  RECURRING_FIELDS,
  ONE_TIME_EARNING_FIELDS,
  FLAT_DEDUCTION_FIELDS,
  resolveSalaryStructure,
  resolveStatutoryComponents,
  getTotalWorkingDays,
  summarizeAttendance,
  dedupeAttendanceByDate,
  calculateEmployeePayroll,
};
