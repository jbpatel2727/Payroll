const PERMISSIONS = [
  { key: 'branches.view', module: 'branches', label: 'View Branches' },
  { key: 'branches.edit', module: 'branches', label: 'Create/Edit/Delete Branches' },
  { key: 'departments.view', module: 'departments', label: 'View Departments' },
  { key: 'departments.edit', module: 'departments', label: 'Create/Edit/Delete Departments' },
  { key: 'employees.view', module: 'employees', label: 'View Employees' },
  { key: 'employees.edit', module: 'employees', label: 'Create/Edit/Delete Employees' },
  { key: 'employees.viewSalary', module: 'employees', label: 'View Employee Salary Details' },
  { key: 'transfers.view', module: 'transfers', label: 'View Branch Transfers' },
  { key: 'transfers.edit', module: 'transfers', label: 'Create/Edit/Delete Transfers' },
  { key: 'attendance.view', module: 'attendance', label: 'View Attendance' },
  { key: 'attendance.edit', module: 'attendance', label: 'Create/Edit/Delete Attendance' },
  { key: 'attendance.bulkMark', module: 'attendance', label: 'Bulk Mark Attendance' },
  { key: 'payroll.view', module: 'payroll', label: 'View Payroll' },
  { key: 'payroll.edit', module: 'payroll', label: 'Edit Payroll Records' },
  { key: 'payroll.generate', module: 'payroll', label: 'Generate Monthly Payroll' },
  { key: 'reports.view', module: 'reports', label: 'View Reports' },
  { key: 'expenses.view', module: 'expenses', label: 'View Expenses' },
  { key: 'expenses.edit', module: 'expenses', label: 'Create/Edit/Delete Expenses' },
  { key: 'settings.view', module: 'settings', label: 'View Settings' },
  { key: 'settings.edit', module: 'settings', label: 'Edit Settings' },
  { key: 'users.view', module: 'users', label: 'View System Users' },
  { key: 'users.manage', module: 'users', label: 'Create/Edit/Delete System Users' },
  { key: 'roles.view', module: 'roles', label: 'View Roles' },
  { key: 'roles.manage', module: 'roles', label: 'Create/Edit/Delete Roles' },
];

const ALL_KEYS = PERMISSIONS.map(p => p.key);

const DEFAULT_ROLES = {
  'Super Admin': ALL_KEYS,
  'HR Admin': [
    'branches.view', 'branches.edit', 'departments.view', 'departments.edit',
    'employees.view', 'employees.edit', 'employees.viewSalary',
    'transfers.view', 'transfers.edit',
    'attendance.view', 'attendance.edit', 'attendance.bulkMark',
    'payroll.view', 'payroll.edit',
    'reports.view',
    'expenses.view', 'expenses.edit',
  ],
  'Manager': [
    'branches.view', 'departments.view',
    'employees.view',
    'transfers.view',
    'attendance.view', 'attendance.edit', 'attendance.bulkMark',
    'reports.view',
  ],
  'Accountant': [
    'branches.view', 'departments.view',
    'employees.viewSalary',
    'payroll.view', 'payroll.edit',
    'reports.view',
    'expenses.view', 'expenses.edit',
  ],
  'Worker': [],
};

async function seedRbac(prisma, { hashPassword, generateRandomPassword }) {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { module: permission.module, label: permission.label },
      create: permission,
    });
  }

  const allPermissions = await prisma.permission.findMany();
  const idByKey = Object.fromEntries(allPermissions.map(p => [p.key, p.id]));

  for (const [roleName, keys] of Object.entries(DEFAULT_ROLES)) {
    const existing = await prisma.role.findUnique({ where: { name: roleName } });
    if (existing) continue;
    const role = await prisma.role.create({
      data: { name: roleName, isSystem: true, description: `Default ${roleName} role` },
    });
    if (keys.length) {
      // Note: skipDuplicates isn't supported on SQLite in Prisma — safe here regardless,
      // since this branch only runs once, right after the role itself was just created.
      await prisma.rolePermission.createMany({
        data: keys.map(key => ({ roleId: role.id, permissionId: idByKey[key] })),
      });
    }
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const superAdminRole = await prisma.role.findUnique({ where: { name: 'Super Admin' } });
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || generateRandomPassword();
    await prisma.user.create({
      data: {
        username: 'admin',
        name: 'Admin User',
        passwordHash: hashPassword(initialPassword),
        roleId: superAdminRole.id,
      },
    });
    console.log(`Created default login -> username: admin, password: ${initialPassword} (change this after first login)`);
  }
}

module.exports = { PERMISSIONS, DEFAULT_ROLES, seedRbac };
