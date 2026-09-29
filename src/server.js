const express = require('express');
const path = require('path');
const { loadDatabase, saveDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;
// cPanel/Passenger terminates HTTPS before proxying to Node, so trust its forwarded-proto header.
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

function loadData() {
  return loadDatabase();
}

function saveData(data) {
  saveDatabase(data);
}

function ensureCollections(data) {
  ['branches', 'departments', 'employees', 'attendance', 'payroll', 'transfers', 'payrollRuns', 'expenses', 'settings', 'authUsers'].forEach(key => {
    if (!Array.isArray(data[key])) data[key] = [];
  });
  let changed = false;
  data.employees.forEach((employee, index) => {
    if (!employee.id) {
      employee.id = Date.now() + index;
      changed = true;
    }
    if (!employee.empCode) {
      employee.empCode = 'EMP-' + String(index + 1).padStart(3, '0');
      changed = true;
    }
    if (employee.baseSalary === undefined && employee.salary !== undefined) {
      employee.baseSalary = number(employee.salary);
      changed = true;
    }
  });
  data.attendance.forEach(record => {
    let employee = data.employees.find(item => String(item.id) === String(record.empId));
    if (!employee && record.empName) {
      employee = data.employees.find(item => item.name === record.empName);
      if (employee) {
        record.empId = employee.id;
        changed = true;
      }
    }
  });
  data.payroll.forEach(record => {
    let employee = data.employees.find(item => String(item.id) === String(record.empId));
    if (!employee && record.empName) {
      employee = data.employees.find(item => item.name === record.empName);
      if (employee) {
        record.empId = employee.id;
        changed = true;
      }
    }
  });
  if (changed) saveData(data);
  return data;
}

function loadDb() {
  return ensureCollections(loadData());
}

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0')}` };
}

function inMonth(date, month) {
  return typeof date === 'string' && date.startsWith(month);
}

function dateInRange(date, start, end) {
  return (!start || date >= start) && (!end || date <= end);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function employeeAllowanceTotal(employee) {
  const structure = employee.allowanceStructure || employee.salaryStructure || {};
  return number(structure.total, number(structure.allowances));
}

function employeeGross(employee) {
  return number(employee.baseSalary, number(employee.salary)) + employeeAllowanceTotal(employee);
}

function getEmployeeTransfer(data, employeeId, month) {
  return (data.transfers || []).filter(transfer => String(transfer.employeeId) === String(employeeId) && transfer.effectiveDate && transfer.effectiveDate.startsWith(month)).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
}

function addException(exceptions, type, message, employeeId) {
  exceptions.push({ type, message, employeeId: employeeId || null });
}

// --- AUTHENTICATION (login/logout via HttpOnly session cookie, no external deps) ---
const crypto = require('crypto');
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_SECRET = process.env.SESSION_SECRET || 'payroll-app-secure-fallback-secret-2026';
const sessions = new Map();

function signToken(payload) {
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, signature] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
    if (signature.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    if (payload.expires && payload.expires < Date.now()) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const check = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === check.length && crypto.timingSafeEqual(expected, check);
  } catch (error) {
    return false;
  }
}

function generateRandomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index === -1) return;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return cookies;
}

function getSession(req) {
  let token = parseCookies(req).session;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && (parts[0].toLowerCase() === 'bearer')) {
      token = parts[1];
    }
  }
  if (!token) return null;
  const verified = verifyToken(token);
  if (verified) return verified;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  return session;
}

function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role };
}

function ensureDefaultAdmin() {
  const db = loadDb();
  if (!db.authUsers || !db.authUsers.length) {
    if (!db.authUsers) db.authUsers = [];
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || generateRandomPassword();
    db.authUsers.push({ id: 1790030679728, username: 'admin', name: 'Admin User', role: 'HR Manager', passwordHash: hashPassword(initialPassword) });
    saveData(db);
    console.log(`Created default login -> username: admin, password: ${initialPassword} (change this after first login)`);
  }
}
ensureDefaultAdmin();

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const db = loadDb();
  
  const cleanUsername = String(username).trim().toLowerCase();
  const cleanPassword = String(password).trim();

  // Find in authUsers
  let user = (db.authUsers || []).find(item => 
    item.username.toLowerCase() === cleanUsername || 
    (item.email && item.email.toLowerCase() === cleanUsername) ||
    (item.name && item.name.toLowerCase() === cleanUsername) ||
    (item.phone && String(item.phone).trim() === cleanUsername)
  );

  // If not found in authUsers, check settings users
  if (!user && Array.isArray(db.settings)) {
    const settingUser = db.settings.find(s => 
      s.category === 'user' && (
        (s.name && s.name.toLowerCase() === cleanUsername) ||
        (s.values?.username && s.values.username.toLowerCase() === cleanUsername) ||
        (s.values?.email && s.values.email.toLowerCase() === cleanUsername) ||
        (s.values?.phone && String(s.values.phone).trim() === cleanUsername)
      )
    );
    if (settingUser) {
      const uName = settingUser.values?.username || settingUser.name;
      const rawPass = settingUser.values?.password || generateRandomPassword();
      user = {
        id: settingUser.id,
        username: uName.toLowerCase().replace(/\s+/g, ''),
        name: settingUser.name,
        phone: settingUser.values?.phone || '',
        email: settingUser.values?.email || '',
        role: settingUser.values?.role || 'Admin',
        passwordHash: hashPassword(rawPass)
      };
      if (!db.authUsers) db.authUsers = [];
      db.authUsers.push(user);
      saveData(db);
    }
  }

  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const isValid = verifyPassword(cleanPassword, user.passwordHash) ||
                  verifyPassword(String(password), user.passwordHash);

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const sessionData = {
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    expires: Date.now() + SESSION_MAX_AGE_MS
  };
  const token = signToken(sessionData);
  sessions.set(token, sessionData);

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const secureFlag = isHttps ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}${secureFlag}`);
  
  const responseData = publicUser(user);
  responseData.token = token;
  res.json(responseData);
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const db = loadDb();
  const user = (db.authUsers || []).find(item => String(item.id) === String(session.userId) || item.username.toLowerCase() === (session.username || '').toLowerCase());
  if (user) {
    const data = publicUser(user);
    data.token = signToken(session);
    return res.json(data);
  }
  if (session.username) {
    return res.json({ id: session.userId, name: session.name || session.username, username: session.username, role: session.role || 'Admin', token: signToken(session) });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// All API routes below this point require an authenticated session.
const PUBLIC_AUTH_PATHS = ['/auth/login', '/auth/logout', '/auth/me'];
app.use('/api', (req, res, next) => {
  if (PUBLIC_AUTH_PATHS.includes(req.path)) return next();
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });
  req.userId = session.userId;
  next();
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const db = loadDb();
  const user = db.authUsers.find(item => item.id === req.userId);
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect' });
  user.passwordHash = hashPassword(newPassword);
  saveData(db);
  res.json({ message: 'Password updated successfully' });
});

// --- SYNC API for client-server state synchronization ---
app.get('/api/sync', (req, res) => {
  res.json(loadDb());
});

app.post('/api/sync', (req, res) => {
  const incoming = req.body || {};
  const db = loadDb();
  let changed = false;

  if (Array.isArray(incoming.branches)) {
    db.branches = incoming.branches;
    changed = true;
  }
  if (Array.isArray(incoming.departments)) {
    db.departments = incoming.departments;
    changed = true;
  }
  if (Array.isArray(incoming.employees)) {
    db.employees = incoming.employees;
    changed = true;
  }
  if (Array.isArray(incoming.settings)) {
    db.settings = incoming.settings;
    changed = true;
  }
  if (Array.isArray(incoming.attendance) && incoming.attendance.length > 0) {
    if (!db.attendance) db.attendance = [];
    incoming.attendance.forEach(incRec => {
      const idx = db.attendance.findIndex(a => String(a.empId) === String(incRec.empId) && a.date === incRec.date);
      if (idx !== -1) {
        Object.assign(db.attendance[idx], incRec);
      } else {
        db.attendance.push(incRec);
      }
    });
    changed = true;
  }
  ['payroll', 'transfers', 'payrollRuns', 'expenses'].forEach(key => {
    if (Array.isArray(incoming[key])) {
      db[key] = incoming[key];
      changed = true;
    }
  });

  if (changed) saveData(db);
  res.json({ success: true, db: loadDb() });
});

// --- 1. BRANCH APIs ---
app.get('/api/branches', (req, res) => {
  res.json(loadDb().branches);
});

app.post('/api/branches', (req, res) => {
  const db = loadData();
  const branch = { id: Date.now(), ...req.body };
  if (!db.branches) db.branches = [];
  db.branches.push(branch);
  saveData(db);
  res.status(201).json(branch);
});

app.post('/api/branches/update', (req, res) => {
  const { id, name, code, address } = req.body;
  const db = loadData();
  const b = (db.branches || []).find(item => String(item.id) === String(id));
  if (b) {
    b.name = name;
    b.code = code;
    b.address = address;
    saveData(db);
    return res.json({ message: 'Branch updated successfully' });
  }
  res.status(404).json({ error: 'Branch not found' });
});

app.post('/api/branches/delete', (req, res) => {
  const { id } = req.body;
  const db = loadData();
  db.branches = (db.branches || []).filter(b => String(b.id) !== String(id));
  saveData(db);
  res.json({ message: 'Branch deleted' });
});

// --- 2. DEPARTMENT APIs ---
app.get('/api/departments', (req, res) => {
  res.json(loadDb().departments);
});

app.post('/api/departments', (req, res) => {
  const db = loadData();
  const dept = { id: Date.now(), ...req.body };
  if (!db.departments) db.departments = [];
  db.departments.push(dept);
  saveData(db);
  res.status(201).json(dept);
});

app.post('/api/departments/update', (req, res) => {
  const { id, name, branchCode } = req.body;
  const db = loadData();
  const d = (db.departments || []).find(item => String(item.id) === String(id));
  if (d) {
    d.name = name;
    d.branchCode = branchCode;
    saveData(db);
    return res.json({ message: 'Department updated successfully' });
  }
  res.status(404).json({ error: 'Department not found' });
});

app.post('/api/departments/delete', (req, res) => {
  const { id } = req.body;
  const db = loadData();
  db.departments = (db.departments || []).filter(d => String(d.id) !== String(id));
  saveData(db);
  res.json({ message: 'Department deleted' });
});

// --- 3. EMPLOYEE APIs ---
app.get('/api/employees', (req, res) => {
  res.json(loadDb().employees);
});

app.get('/api/employees/:id', (req, res) => {
  const db = loadDb();
  const emp = (db.employees || []).find(e => String(e.id) === String(req.params.id));
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  res.json(emp);
});

app.post('/api/employees', (req, res) => {
  const db = loadDb();
  const incomingId = req.body.id ? (Number(req.body.id) || req.body.id) : (Date.now() + Math.random());
  const empCode = req.body.empCode || ('EMP-' + String((db.employees || []).length + 1).padStart(3, '0'));
  const salary = number(req.body.salary ?? req.body.baseSalary);
  
  const emp = {
    id: incomingId,
    empCode,
    name: req.body.name || '',
    email: req.body.email || '',
    phone: req.body.phone || '',
    address: req.body.address || '',
    deptName: req.body.deptName || req.body.dept || 'General',
    branchCode: req.body.branchCode || '',
    salary: salary,
    baseSalary: salary,
    profilePhoto: req.body.profilePhoto || req.body.photo || '',
    workSchedule: req.body.workSchedule || (req.body.shift ? { shiftName: req.body.shift } : { shiftName: 'Morning Regular' }),
    createdAt: new Date().toISOString()
  };

  if (!db.employees) db.employees = [];
  
  const existingIndex = db.employees.findIndex(e => String(e.id) === String(emp.id) || (emp.empCode && e.empCode && e.empCode.toLowerCase() === emp.empCode.toLowerCase()));
  if (existingIndex !== -1) {
    db.employees[existingIndex] = Object.assign(db.employees[existingIndex], emp);
  } else {
    db.employees.push(emp);
  }

  saveData(db);
  res.status(201).json(emp);
});

app.put('/api/employees/:id', (req, res) => {
  const db = loadDb();
  const paramId = req.params.id;
  let emp = (db.employees || []).find(e => String(e.id) === String(paramId) || (typeof e.id === 'number' && !isNaN(Number(paramId)) && e.id === Number(paramId)));
  
  if (!emp && req.body.empCode) {
    emp = (db.employees || []).find(e => e.empCode && e.empCode.toLowerCase() === req.body.empCode.toLowerCase());
  }

  if (!emp) {
    const newId = (!isNaN(Number(paramId)) ? Number(paramId) : paramId) || Date.now();
    const salary = number(req.body.salary ?? req.body.baseSalary);
    emp = {
      id: newId,
      empCode: req.body.empCode || ('EMP-' + String((db.employees || []).length + 1).padStart(3, '0')),
      name: req.body.name || '',
      email: req.body.email || '',
      phone: req.body.phone || '',
      address: req.body.address || '',
      deptName: req.body.deptName || req.body.dept || 'General',
      branchCode: req.body.branchCode || '',
      salary: salary,
      baseSalary: salary,
      profilePhoto: req.body.profilePhoto || req.body.photo || '',
      workSchedule: req.body.workSchedule || (req.body.shift ? { shiftName: req.body.shift } : { shiftName: 'Morning Regular' }),
      createdAt: new Date().toISOString()
    };
    if (!db.employees) db.employees = [];
    db.employees.push(emp);
    saveData(db);
    return res.json(emp);
  }

  const oldName = emp.name;
  if (req.body.name !== undefined) emp.name = req.body.name;
  if (req.body.empCode !== undefined) emp.empCode = req.body.empCode;
  if (req.body.email !== undefined) emp.email = req.body.email;
  if (req.body.phone !== undefined) emp.phone = req.body.phone;
  if (req.body.address !== undefined) emp.address = req.body.address;
  if (req.body.deptName !== undefined) emp.deptName = req.body.deptName;
  if (req.body.dept !== undefined) emp.deptName = req.body.dept;
  if (req.body.branchCode !== undefined) emp.branchCode = req.body.branchCode;
  if (req.body.salary !== undefined) {
    emp.salary = number(req.body.salary);
    emp.baseSalary = number(req.body.salary);
  }
  if (req.body.baseSalary !== undefined) {
    emp.baseSalary = number(req.body.baseSalary);
    emp.salary = number(req.body.baseSalary);
  }
  if (req.body.profilePhoto !== undefined) emp.profilePhoto = req.body.profilePhoto;
  if (req.body.photo !== undefined) emp.profilePhoto = req.body.photo;
  if (req.body.workSchedule !== undefined) emp.workSchedule = req.body.workSchedule;
  if (req.body.shift !== undefined) emp.workSchedule = { shiftName: req.body.shift };

  if (oldName && emp.name && oldName !== emp.name && Array.isArray(db.attendance)) {
    db.attendance.forEach(a => {
      if (String(a.empId) === String(emp.id) || a.empName === oldName) a.empName = emp.name;
    });
  }

  saveData(db);
  res.json(emp);
});

app.delete('/api/employees/:id', (req, res) => {
  const db = loadDb();
  const paramId = req.params.id;
  db.employees = (db.employees || []).filter(e => String(e.id) !== String(paramId));
  if (Array.isArray(db.attendance)) {
    db.attendance = db.attendance.filter(a => String(a.empId) !== String(paramId));
  }
  if (Array.isArray(db.payroll)) {
    db.payroll = db.payroll.filter(p => String(p.empId) !== String(paramId));
  }
  saveData(db);
  res.json({ message: 'Employee deleted', id: paramId });
});

// Shift Branch API (legacy support)
app.post('/api/employees/update-branch', (req, res) => {
  const { id, branchCode } = req.body;
  const db = loadDb();
  const emp = (db.employees || []).find(e => String(e.id) === String(id));
  if (emp) {
    emp.branchCode = branchCode;
    saveData(db);
    return res.json({ message: 'Branch shifted successfully' });
  }
  res.status(404).json({ error: 'Employee not found' });
});

// Full Profile Edit (legacy support)
app.post('/api/employees/update-full', (req, res) => {
  const { id, name, email, salary, branchCode, deptName } = req.body;
  const db = loadDb();
  const emp = (db.employees || []).find(e => String(e.id) === String(id));
  if (emp) {
    const oldName = emp.name;
    emp.name = name;
    emp.email = email;
    emp.salary = Number(salary);
    emp.baseSalary = Number(salary);
    emp.branchCode = branchCode;
    emp.deptName = deptName;

    if (oldName !== name && db.attendance) {
      db.attendance.forEach(a => { if (a.empName === oldName) a.empName = name; });
    }
    saveData(db);
    return res.json({ message: 'Employee updated successfully' });
  }
  res.status(404).json({ error: 'Employee not found' });
});

// Employee Delete (legacy support)
app.post('/api/employees/delete', (req, res) => {
  const { id } = req.body;
  const db = loadDb();
  db.employees = (db.employees || []).filter(e => String(e.id) !== String(id));
  saveData(db);
  res.json({ message: 'Employee deleted' });
});

app.get('/api/transfers', (req, res) => {
  res.json(loadDb().transfers);
});

app.post('/api/transfers', (req, res) => {
  const { employeeId, sourceBranch, targetBranch, effectiveDate, relocationAllowance, salaryRevision, department } = req.body;
  const db = loadDb();
  const employee = db.employees.find(item => String(item.id) === String(employeeId));
  const targetExists = db.branches.some(branch => branch.code === targetBranch);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (!sourceBranch || !targetBranch || !effectiveDate) return res.status(400).json({ error: 'Source branch, target branch, and effective date are required' });
  if (!targetExists) return res.status(400).json({ error: 'Target branch not found' });
  if (sourceBranch === targetBranch) return res.status(400).json({ error: 'Source and target branches must differ' });
  const transfer = {
    id: Date.now() + Math.random(), employeeId: employee.id, sourceBranch, targetBranch,
    effectiveDate, relocationAllowance: number(relocationAllowance), salaryRevision: number(salaryRevision),
    department: department || employee.deptName || '', status: 'Approved', createdAt: new Date().toISOString()
  };
  db.transfers.push(transfer);
  saveData(db);
  res.status(201).json(transfer);
});

// --- 4. ATTENDANCE APIs ---
app.get('/api/attendance', (req, res) => {
  res.json(loadDb().attendance);
});

app.post('/api/attendance', (req, res) => {
  const db = loadDb();
  const { empId, empName, date, status, daysWorked, overtimeHours, unpaidLeave, paidLeave, gazettedHoliday } = req.body;
  const emp = db.employees.find(e => String(e.id) === String(empId)) || (empName ? db.employees.find(e => e.name === empName) : null);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!date || !['Present', 'Half Day', 'Half Leave', 'Absent', 'On Leave'].includes(status)) return res.status(400).json({ error: 'Valid date and status are required' });
  if (emp.dateOfJoining && date < emp.dateOfJoining) return res.status(400).json({ error: 'Attendance is before the employee joining date' });
  if (emp.relievingDate && date > emp.relievingDate) return res.status(400).json({ error: 'Attendance is after the employee relieving date' });

  if (!db.attendance) db.attendance = [];
  const existing = db.attendance.find(a => String(a.empId) === String(emp.id) && a.date === date);
  if (existing) {
    Object.assign(existing, {
      empName: emp.name,
      status,
      daysWorked: number(daysWorked, status === 'Present' ? 1 : status === 'Half Day' ? 0.5 : 0),
      overtimeHours: number(overtimeHours),
      unpaidLeave: number(unpaidLeave),
      paidLeave: number(paidLeave),
      gazettedHoliday: number(gazettedHoliday)
    });
    saveData(db);
    return res.json(existing);
  }

  const record = {
    id: Date.now(),
    empId: emp.id,
    empName: emp.name,
    date,
    status,
    daysWorked: number(daysWorked, status === 'Present' ? 1 : status === 'Half Day' ? 0.5 : 0),
    overtimeHours: number(overtimeHours),
    unpaidLeave: number(unpaidLeave),
    paidLeave: number(paidLeave),
    gazettedHoliday: number(gazettedHoliday),
    branchCode: emp.branchCode || '-',
    deptName: emp.deptName || '-'
  };

  db.attendance.push(record);
  saveData(db);
  res.status(201).json(record);
});

app.post('/api/attendance/mark-all-present', (req, res) => {
  const { date } = req.body;
  const db = loadData();

  if (!db.attendance) db.attendance = [];
  if (!db.employees || db.employees.length === 0) {
    return res.status(400).json({ error: 'No employees found' });
  }

  db.employees.forEach(emp => {
    const exists = db.attendance.some(a => String(a.empId) === String(emp.id) && a.date === date);
    if (!exists) {
      db.attendance.push({
        id: Date.now() + Math.random(),
        empId: emp.id,
        empName: emp.name,
        date: date,
        status: 'Present',
        branchCode: emp.branchCode || '-',
        deptName: emp.deptName || '-'
      });
    }
  });

  saveData(db);
  res.status(201).json({ message: 'All employees marked present' });
});

app.post('/api/attendance/update', (req, res) => {
  const { id, status, overtimeHours } = req.body;
  const db = loadData();
  const record = (db.attendance || []).find(a => String(a.id) === String(id));
  if (record) {
    record.status = status;
    if (overtimeHours !== undefined) record.overtimeHours = number(overtimeHours);
    saveData(db);
    return res.json({ message: 'Attendance updated' });
  }
  res.status(404).json({ error: 'Record not found' });
});

app.post('/api/attendance/delete', (req, res) => {
  const { id } = req.body;
  const db = loadData();
  if (db.attendance) {
    db.attendance = db.attendance.filter(a => String(a.id) !== String(id));
    saveData(db);
    return res.json({ message: 'Attendance deleted' });
  }
  res.status(400).json({ error: 'No attendance records' });
});

// --- 5. PAYROLL APIs ---
app.get('/api/payroll', (req, res) => {
  res.json(loadDb().payroll);
});

app.post('/api/payroll/generate', (req, res) => {
  const { month, workingDays, overtimeMultiplier = 1.5, statutoryDeductions = 0, gazettedHolidays = 0 } = req.body;
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Month must use YYYY-MM format' });
  const db = loadDb();
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const totalWorkingDays = number(workingDays, Array.from({ length: daysInMonth }, (_, index) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, index + 1).getDay()).filter(day => day !== 0 && day !== 6).length);
  const exceptions = [];
  const generatedPayrolls = db.employees.map(emp => {
    const grossMonthly = employeeGross(emp);
    const perDayRate = grossMonthly / Math.max(totalWorkingDays, 1);
    const transfer = getEmployeeTransfer(db, emp.id, month);
    const attendance = db.attendance.filter(record => String(record.empId) === String(emp.id)).filter(record => inMonth(record.date, month) && dateInRange(record.date, emp.dateOfJoining, emp.relievingDate));
    if (!attendance.length) addException(exceptions, 'Missing attendance', `${emp.name} (${emp.empCode || emp.id}) has no attendance records for ${month}`, emp.id);
    if (transfer && transfer.status !== 'Approved') addException(exceptions, 'Unapproved transfer', `${emp.name} (${emp.empCode || emp.id}) has an unapproved transfer`, emp.id);

    const transferDate = transfer?.effectiveDate;
    const sourceRecords = attendance.filter(record => !transferDate || record.date < transferDate);
    const targetRecords = transfer ? attendance.filter(record => record.date >= transferDate) : [];
    const summarize = records => {
      const worked = records.reduce((sum, record) => sum + number(record.daysWorked, record.status === 'Present' ? 1 : record.status === 'Half Day' ? 0.5 : 0), 0);
      const paidLeave = records.reduce((sum, record) => sum + number(record.paidLeave), 0);
      const holidays = records.reduce((sum, record) => sum + number(record.gazettedHoliday), 0);
      const lwp = records.reduce((sum, record) => sum + number(record.unpaidLeave) + (record.status === 'Absent' ? 1 : 0), 0);
      const overtimeHours = records.reduce((sum, record) => sum + number(record.overtimeHours || record.extraHours), 0);
      return { worked, paidLeave, holidays, lwp, overtimeHours };
    };
    const source = summarize(sourceRecords);
    const target = summarize(targetRecords);
    const payableDays = source.worked + source.paidLeave + source.holidays + target.worked + target.paidLeave + target.holidays + number(gazettedHolidays);
    const lopDays = Math.max(0, totalWorkingDays - payableDays);
    const sourceDays = transfer ? Math.max(0, Math.round((new Date(transferDate) - new Date(`${month}-01`)) / 86400000)) : totalWorkingDays;
    const targetDays = transfer ? totalWorkingDays - sourceDays : 0;
    const holidaySource = transfer ? Math.min(number(gazettedHolidays), sourceDays) : number(gazettedHolidays);
    const holidayTarget = transfer ? Math.max(0, number(gazettedHolidays) - holidaySource) : 0;
    const sourceGross = Math.round(perDayRate * Math.min(sourceDays, source.worked + source.paidLeave + source.holidays + holidaySource));
    const targetGross = Math.round(perDayRate * Math.min(targetDays, target.worked + target.paidLeave + target.holidays + holidayTarget));
    const relocation = transfer ? number(transfer.relocationAllowance) : 0;
    const salaryRevision = transfer ? number(transfer.salaryRevision) : 0;
    const overtimeHours = source.overtimeHours + target.overtimeHours;
    const hourlyRate = perDayRate / 8;
    const overtimePay = Math.round(overtimeHours * hourlyRate * number(overtimeMultiplier, 1.5));
    const lopDeduction = Math.round(lopDays * perDayRate);
    const statutory = number(statutoryDeductions);
    const grossPay = sourceGross + targetGross + overtimePay + relocation + salaryRevision;
    const deductions = lopDeduction + statutory;
    const netPay = Math.max(0, grossPay - deductions);
    if (netPay < 0) addException(exceptions, 'Negative net pay', `${emp.name} (${emp.empCode || emp.id}) calculated a negative net pay`, emp.id);
    if (transfer && !sourceRecords.length) addException(exceptions, 'Missing source attendance', `${emp.name} (${emp.empCode || emp.id}) has no source-branch attendance before ${transfer.effectiveDate}`, emp.id);
    if (transfer && !targetRecords.length) addException(exceptions, 'Missing target attendance', `${emp.name} (${emp.empCode || emp.id}) has no target-branch attendance from ${transfer.effectiveDate}`, emp.id);
    return {
      id: Date.now() + Math.random(), empId: emp.id, empName: emp.name, empCode: emp.empCode || '', month,
      sourceBranch: transfer?.sourceBranch || emp.branchCode || '-', targetBranch: transfer?.targetBranch || emp.branchCode || '-',
      transferDate: transfer?.effectiveDate || '', daysSource: source.worked + source.paidLeave + source.holidays, daysTarget: target.worked + target.paidLeave + target.holidays,
      totalWorkingDays, payableDays, lopDays, baseSalary: grossMonthly, sourceGross, targetGross,
      overtimeHours, overtimePay, relocationAllowance: relocation, salaryRevision, grossPay, deductions,
      lopDeduction, statutoryDeductions: statutory, netPay, netSalary: netPay,
      branchAllocation: [{ branch: transfer?.sourceBranch || emp.branchCode || '-', amount: sourceGross }, ...(transfer ? [{ branch: transfer.targetBranch, amount: targetGross + relocation + salaryRevision }] : [])]
    };
  });
  db.payroll = db.payroll.filter(record => record.month !== month).concat(generatedPayrolls);
  db.payrollRuns = db.payrollRuns.filter(run => run.month !== month);
  db.payrollRuns.push({ id: Date.now(), month, workingDays: totalWorkingDays, generatedAt: new Date().toISOString(), exceptions });
  saveData(db);
  res.status(201).json({ month, workingDays: totalWorkingDays, records: generatedPayrolls, exceptions });
});

// --- 6. REPORT API ---
app.get('/api/reports/monthly', (req, res) => {
  const { month, branch, dept, empId, emp } = req.query;
  const db = loadData();

  let filtered = db.payroll || [];
  if (month) filtered = filtered.filter(p => p.month === month);

  filtered = filtered.map(p => {
    const empAttd = (db.attendance || []).find(a => String(a.empId) === String(p.empId) && a.date.startsWith(p.month));
    const empInfo = (db.employees || []).find(e => String(e.id) === String(p.empId)) || {};

    return {
      ...p,
      empCode: empInfo.empCode || '',
      branchCode: empAttd ? empAttd.branchCode : (empInfo.branchCode || '-'),
      deptName: empAttd ? empAttd.deptName : (empInfo.deptName || '-')
    };
  });

  if (branch) filtered = filtered.filter(p => p.branchCode === branch);
  if (dept) filtered = filtered.filter(p => p.deptName === dept);
  if (empId) filtered = filtered.filter(p => String(p.empId) === String(empId));
  else if (emp) filtered = filtered.filter(p => p.empName === emp);

  res.json(filtered);
});

app.get('/api/payroll/:month/summary', (req, res) => {
  const db = loadDb();
  const records = db.payroll.filter(record => record.month === req.params.month);
  const run = db.payrollRuns.find(item => item.month === req.params.month) || { exceptions: [] };
  const transfers = db.transfers.filter(item => item.effectiveDate && item.effectiveDate.startsWith(req.params.month));
  res.json({
    month: req.params.month,
    records,
    exceptions: run.exceptions || [],
    transfers,
    branchAllocations: records.flatMap(record => record.branchAllocation || []).reduce((summary, allocation) => {
      summary[allocation.branch] = (summary[allocation.branch] || 0) + number(allocation.amount);
      return summary;
    }, {})
  });
});

// REST CRUD aliases used by the settings and future data-management screens.
app.put('/api/branches/:id', (req, res) => {
  const db = loadDb();
  const branch = db.branches.find(item => String(item.id) === String(req.params.id));
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  Object.assign(branch, { name: req.body.name ?? branch.name, code: req.body.code ?? branch.code, address: req.body.address ?? branch.address });
  saveData(db); res.json(branch);
});

app.delete('/api/branches/:id', (req, res) => {
  const db = loadDb(); db.branches = db.branches.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Branch deleted' });
});

app.put('/api/departments/:id', (req, res) => {
  const db = loadDb(); const department = db.departments.find(item => String(item.id) === String(req.params.id));
  if (!department) return res.status(404).json({ error: 'Department not found' });
  Object.assign(department, { name: req.body.name ?? department.name, branchCode: req.body.branchCode ?? department.branchCode });
  saveData(db); res.json(department);
});

app.delete('/api/departments/:id', (req, res) => {
  const db = loadDb(); db.departments = db.departments.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Department deleted' });
});

app.put('/api/attendance/:id', (req, res) => {
  const db = loadDb(); const record = db.attendance.find(item => String(item.id) === String(req.params.id));
  if (!record) return res.status(404).json({ error: 'Attendance record not found' });
  Object.assign(record, req.body, { id: record.id, empId: record.empId }); saveData(db); res.json(record);
});

app.delete('/api/attendance/:id', (req, res) => {
  const db = loadDb(); db.attendance = db.attendance.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Attendance deleted' });
});

app.put('/api/transfers/:id', (req, res) => {
  const db = loadDb(); const transfer = db.transfers.find(item => String(item.id) === String(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  Object.assign(transfer, req.body, { id: transfer.id, employeeId: transfer.employeeId }); saveData(db); res.json(transfer);
});

app.delete('/api/transfers/:id', (req, res) => {
  const db = loadDb(); db.transfers = db.transfers.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Transfer deleted' });
});

app.get('/api/expenses', (req, res) => res.json(loadDb().expenses));

app.post('/api/expenses', (req, res) => {
  const { category, amount, date, note, payrollMonth, employeeId, employeeName } = req.body;
  if (!category || number(amount) <= 0) return res.status(400).json({ error: 'Category and positive amount are required' });
  const db = loadDb(); const expense = { id: Date.now() + Math.random(), category, amount: number(amount), date: date || new Date().toISOString().slice(0, 10), note: note || '', payrollMonth: payrollMonth || '', employeeId: employeeId || null, employeeName: employeeName || '', source: req.body.source || 'Manual' };
  db.expenses.push(expense); saveData(db); res.status(201).json(expense);
});

app.put('/api/expenses/:id', (req, res) => {
  const db = loadDb(); const expense = db.expenses.find(item => String(item.id) === String(req.params.id));
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  Object.assign(expense, req.body, { id: expense.id, amount: number(req.body.amount ?? expense.amount) }); saveData(db); res.json(expense);
});

app.delete('/api/expenses/:id', (req, res) => {
  const db = loadDb(); db.expenses = db.expenses.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Expense deleted' });
});

app.put('/api/payroll/:id', (req, res) => {
  const db = loadDb(); const payroll = db.payroll.find(item => String(item.id) === String(req.params.id));
  if (!payroll) return res.status(404).json({ error: 'Payroll record not found' });
  Object.assign(payroll, req.body, { id: payroll.id, empId: payroll.empId }); saveData(db); res.json(payroll);
});

app.delete('/api/payroll/:id', (req, res) => {
  const db = loadDb(); db.payroll = db.payroll.filter(item => String(item.id) !== String(req.params.id)); saveData(db); res.json({ message: 'Payroll record deleted' });
});

app.get('/api/settings', (req, res) => {
  res.json(loadDb().settings);
});

app.post('/api/settings', (req, res) => {
  const { id, category, name, values } = req.body;
  if (!category || !name) return res.status(400).json({ error: 'Category and name are required' });
  const db = loadDb();
  const settingId = id ? (Number(id) || id) : (Date.now() + Math.random());
  const setting = { id: settingId, category, name, values: values || {}, createdAt: new Date().toISOString() };
  if (!db.settings) db.settings = [];
  db.settings.push(setting);

  if (category === 'user') {
    if (!db.authUsers) db.authUsers = [];
    const uName = (values?.username || name).trim();
    const rawPass = values?.password || generateRandomPassword();
    const authUser = {
      id: setting.id,
      username: uName.toLowerCase().replace(/\s+/g, ''),
      name: name,
      phone: values?.phone || '',
      email: values?.email || '',
      role: values?.role || 'Admin',
      passwordHash: hashPassword(rawPass)
    };
    db.authUsers.push(authUser);
  }

  saveData(db);
  res.status(201).json(setting);
});

app.delete('/api/settings/:id', (req, res) => {
  const db = loadDb();
  db.settings = (db.settings || []).filter(setting => String(setting.id) !== String(req.params.id));
  db.authUsers = (db.authUsers || []).filter(user => String(user.id) !== String(req.params.id));
  saveData(db);
  res.json({ message: 'Setting removed' });
});

app.put('/api/settings/:id', (req, res) => {
  const db = loadDb();
  const paramId = req.params.id;
  let setting = (db.settings || []).find(item => String(item.id) === String(paramId) || (typeof item.id === 'number' && !isNaN(Number(paramId)) && item.id === Number(paramId)));
  
  if (!setting && req.body.category && req.body.name) {
    setting = (db.settings || []).find(item => item.category === req.body.category && item.name === req.body.name);
  }

  if (!setting) {
    setting = {
      id: (!isNaN(Number(paramId)) ? Number(paramId) : paramId) || Date.now(),
      category: req.body.category || 'general',
      name: req.body.name || 'Setting',
      values: req.body.values || {},
      createdAt: new Date().toISOString()
    };
    if (!db.settings) db.settings = [];
    db.settings.push(setting);
  } else {
    setting.category = req.body.category || setting.category;
    setting.name = req.body.name || setting.name;
    setting.values = req.body.values || setting.values || {};
  }

  if (setting.category === 'user' || req.body.category === 'user') {
    if (!db.authUsers) db.authUsers = [];
    let authUser = db.authUsers.find(u => String(u.id) === String(setting.id) || (setting.values?.username && u.username === setting.values.username.toLowerCase()));
    const uName = (setting.values.username || setting.name).trim();
    if (!authUser) {
      authUser = {
        id: setting.id,
        username: uName.toLowerCase().replace(/\s+/g, ''),
        name: setting.name,
        phone: setting.values.phone || '',
        email: setting.values.email || '',
        role: setting.values.role || 'Admin',
        passwordHash: hashPassword(setting.values.password || generateRandomPassword())
      };
      db.authUsers.push(authUser);
    } else {
      authUser.name = setting.name;
      authUser.username = uName.toLowerCase().replace(/\s+/g, '');
      authUser.phone = setting.values.phone || authUser.phone || '';
      authUser.email = setting.values.email || authUser.email || '';
      authUser.role = setting.values.role || authUser.role || 'Admin';
      if (setting.values.password) {
        authUser.passwordHash = hashPassword(setting.values.password);
      }
    }
  }

  saveData(db);
  res.json(setting);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;