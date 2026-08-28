require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EXAM_WEEKS_FILE = path.join(DATA_DIR, 'examWeeks.json');
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');
const EXAMS_FILE = path.join(DATA_DIR, 'exams.json');
const AVAILABILITIES_FILE = path.join(DATA_DIR, 'availabilities.json');
const ALLOCATIONS_FILE = path.join(DATA_DIR, 'allocations.json');

async function initDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = [USERS_FILE, EXAM_WEEKS_FILE, TEACHERS_FILE, EXAMS_FILE, AVAILABILITIES_FILE, ALLOCATIONS_FILE];
  for (const file of files) {
    try { await fs.access(file); } 
    catch { await fs.writeFile(file, '[]'); }
  }
}
initDataFiles();

async function readJSON(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    return [];
  }
}
async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

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

// ---- Auth ----
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const emailLower = email.toLowerCase();
    const users = await readJSON(USERS_FILE);
    if (users.find(u => u.email.toLowerCase() === emailLower)) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      username,
      email: emailLower,
      passwordHash: hashed,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    await writeJSON(USERS_FILE, users);
    res.status(201).json({ message: 'User created successfully.' });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = await readJSON(USERS_FILE);
    const emailLower = email.toLowerCase();
    const user = users.find(u => u.email.toLowerCase() === emailLower);
    
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Teachers ----
app.get('/api/teachers', authenticate, async (req, res) => {
  try { res.json(await readJSON(TEACHERS_FILE)); } 
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/teachers', authenticate, async (req, res) => {
  try {
    const teachers = await readJSON(TEACHERS_FILE);
    const newTeacher = { id: uuidv4(), ...req.body };
    teachers.push(newTeacher);
    await writeJSON(TEACHERS_FILE, teachers);
    res.status(201).json(newTeacher);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/teachers/bulk', authenticate, async (req, res) => {
  try {
    const teachers = await readJSON(TEACHERS_FILE);
    const newTeachers = req.body.teachers.map(t => ({ id: uuidv4(), ...t }));
    teachers.push(...newTeachers);
    await writeJSON(TEACHERS_FILE, teachers);
    res.status(201).json({ added: newTeachers.length });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/teachers/:id', authenticate, async (req, res) => {
  try {
    const teachers = await readJSON(TEACHERS_FILE);
    const idx = teachers.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    teachers[idx] = { ...teachers[idx], ...req.body };
    await writeJSON(TEACHERS_FILE, teachers);
    res.json(teachers[idx]);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/teachers/:id', authenticate, async (req, res) => {
  try {
    let teachers = await readJSON(TEACHERS_FILE);
    teachers = teachers.filter(t => t.id !== req.params.id);
    await writeJSON(TEACHERS_FILE, teachers);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ---- Exam Weeks ----
app.get('/api/exam-weeks', authenticate, async (req, res) => {
  try { res.json(await readJSON(EXAM_WEEKS_FILE)); } 
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/exam-weeks', authenticate, async (req, res) => {
  try {
    const weeks = await readJSON(EXAM_WEEKS_FILE);
    const newWeek = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
    weeks.push(newWeek);
    await writeJSON(EXAM_WEEKS_FILE, weeks);
    res.status(201).json(newWeek);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ---- Exams ----
app.get('/api/exams/all', authenticate, async (req, res) => {
  try { res.json(await readJSON(EXAMS_FILE)); } 
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/exams', authenticate, async (req, res) => {
  try {
    const exams = await readJSON(EXAMS_FILE);
    const newExam = { id: uuidv4(), ...req.body };
    exams.push(newExam);
    await writeJSON(EXAMS_FILE, exams);
    res.status(201).json(newExam);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ---- Allocations ----
app.get('/api/allocations/all', authenticate, async (req, res) => {
  try { res.json(await readJSON(ALLOCATIONS_FILE)); } 
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/allocations', authenticate, async (req, res) => {
  try {
    const { examWeekId, allocations, isFinal } = req.body;
    const allAlloc = await readJSON(ALLOCATIONS_FILE);
    const filtered = allAlloc.filter(a => a.examWeekId !== examWeekId);
    const newAlloc = { id: uuidv4(), examWeekId, allocations, isFinal: !!isFinal, createdAt: new Date().toISOString() };
    filtered.push(newAlloc);
    await writeJSON(ALLOCATIONS_FILE, filtered);
    res.status(201).json(newAlloc);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
