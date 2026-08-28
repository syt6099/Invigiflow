require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// ---------- File-based storage (replace with DB later) ----------
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EXAM_WEEKS_FILE = path.join(DATA_DIR, 'examWeeks.json');
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');
const EXAMS_FILE = path.join(DATA_DIR, 'exams.json');
const AVAILABILITIES_FILE = path.join(DATA_DIR, 'availabilities.json');
const ALLOCATIONS_FILE = path.join(DATA_DIR, 'allocations.json');

// Ensure data directory and files exist
async function initDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = [USERS_FILE, EXAM_WEEKS_FILE, TEACHERS_FILE, EXAMS_FILE, AVAILABILITIES_FILE, ALLOCATIONS_FILE];
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]');
    }
  }
}
initDataFiles();

// Helper: read/write JSON
async function readJSON(file) {
  const data = await fs.readFile(file, 'utf8');
  return JSON.parse(data);
}
async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// ---------- Email transporter ----------
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_PORT === '465',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Middleware: verify JWT ----------
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Routes ----------

// ---- Auth ----
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const users = await readJSON(USERS_FILE);
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hashed = await bcrypt.hash(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    email,
    passwordHash: hashed,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  await writeJSON(USERS_FILE, users);
  // In production, send verification email here; we'll just return success.
  res.status(201).json({ message: 'User created. Please verify your email.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const users = await readJSON(USERS_FILE);
  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// Forgot password – send code
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const users = await readJSON(USERS_FILE);
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Generate 6-digit code and store temporarily (in-memory for simplicity)
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  // You should store code with expiry in a temporary store (e.g., Redis or a simple object)
  // For demo, we store in a global object (will be lost on server restart)
  if (!global.resetCodes) global.resetCodes = {};
  global.resetCodes[email] = { code, expires: Date.now() + 10 * 60 * 1000 };
  // Send email
  await transporter.sendMail({
    from: `"Invigiflow" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Password Reset Code',
    html: `<p>Your password reset code is: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
  });
  res.json({ message: 'Code sent to your email.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!global.resetCodes || !global.resetCodes[email]) {
    return res.status(400).json({ error: 'No reset request found' });
  }
  const stored = global.resetCodes[email];
  if (stored.code !== code || Date.now() > stored.expires) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const users = await readJSON(USERS_FILE);
  const userIndex = users.findIndex(u => u.email === email);
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
  users[userIndex].passwordHash = await bcrypt.hash(newPassword, 10);
  await writeJSON(USERS_FILE, users);
  delete global.resetCodes[email];
  res.json({ message: 'Password reset successfully.' });
});

// ---- Teacher DB ----
app.get('/api/teachers', authenticate, async (req, res) => {
  const teachers = await readJSON(TEACHERS_FILE);
  // In a real multi-user system, filter by userId; for now return all (single-user demo)
  res.json(teachers);
});

app.post('/api/teachers', authenticate, async (req, res) => {
  const teachers = await readJSON(TEACHERS_FILE);
  const newTeacher = { id: uuidv4(), ...req.body };
  teachers.push(newTeacher);
  await writeJSON(TEACHERS_FILE, teachers);
  res.status(201).json(newTeacher);
});

app.put('/api/teachers/:id', authenticate, async (req, res) => {
  const teachers = await readJSON(TEACHERS_FILE);
  const idx = teachers.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Teacher not found' });
  teachers[idx] = { ...teachers[idx], ...req.body };
  await writeJSON(TEACHERS_FILE, teachers);
  res.json(teachers[idx]);
});

app.delete('/api/teachers/:id', authenticate, async (req, res) => {
  let teachers = await readJSON(TEACHERS_FILE);
  teachers = teachers.filter(t => t.id !== req.params.id);
  await writeJSON(TEACHERS_FILE, teachers);
  res.json({ message: 'Deleted' });
});

// ---- Exam Weeks ----
app.get('/api/exam-weeks', authenticate, async (req, res) => {
  const weeks = await readJSON(EXAM_WEEKS_FILE);
  res.json(weeks);
});

app.post('/api/exam-weeks', authenticate, async (req, res) => {
  const weeks = await readJSON(EXAM_WEEKS_FILE);
  const newWeek = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
  weeks.push(newWeek);
  await writeJSON(EXAM_WEEKS_FILE, weeks);
  res.status(201).json(newWeek);
});

// ---- Exams ----
app.get('/api/exam-weeks/:weekId/exams', authenticate, async (req, res) => {
  const exams = await readJSON(EXAMS_FILE);
  const filtered = exams.filter(e => e.examWeekId === req.params.weekId);
  res.json(filtered);
});

app.post('/api/exams', authenticate, async (req, res) => {
  const exams = await readJSON(EXAMS_FILE);
  const newExam = { id: uuidv4(), ...req.body };
  exams.push(newExam);
  await writeJSON(EXAMS_FILE, exams);
  res.status(201).json(newExam);
});

// ---- Availabilities ----
app.post('/api/availabilities', authenticate, async (req, res) => {
  const avail = await readJSON(AVAILABILITIES_FILE);
  const newSlot = { id: uuidv4(), ...req.body };
  avail.push(newSlot);
  await writeJSON(AVAILABILITIES_FILE, avail);
  res.status(201).json(newSlot);
});

// ---- Allocations ----
app.post('/api/allocations', authenticate, async (req, res) => {
  // Expect { examWeekId, allocations: [ { examId, teacherIds } ] }
  const { examWeekId, allocations } = req.body;
  const allAlloc = await readJSON(ALLOCATIONS_FILE);
  // Remove old allocations for this week
  const filtered = allAlloc.filter(a => a.examWeekId !== examWeekId);
  const newAlloc = { id: uuidv4(), examWeekId, allocations, createdAt: new Date().toISOString() };
  filtered.push(newAlloc);
  await writeJSON(ALLOCATIONS_FILE, filtered);
  res.status(201).json(newAlloc);
});

app.get('/api/allocations/:examWeekId', authenticate, async (req, res) => {
  const allAlloc = await readJSON(ALLOCATIONS_FILE);
  const found = allAlloc.find(a => a.examWeekId === req.params.examWeekId);
  res.json(found || { allocations: [] });
});

// ---- Email sending ----
app.post('/api/send-email', authenticate, async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient' });
  try {
    await transporter.sendMail({
      from: `"Invigiflow" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    res.json({ message: 'Email sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});


// Welcome route (optional)
app.get('/', (req, res) => {
    res.json({
        message: 'Invigiflow API is running!',
        endpoints: {
            auth: '/api/auth',
            teachers: '/api/teachers',
            examWeeks: '/api/exam-weeks',
            exams: '/api/exams',
            allocations: '/api/allocations'
        }
    });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
