require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// --- CORS ---
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
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// ---------- Email transporter ----------
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp-mail.outlook.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    requireTLS: true,
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

// ============================================================
//  AUTH ROUTES
// ============================================================

app.post('/api/auth/signup', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const normalizedEmail = email.toLowerCase().trim();
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        const hashed = await bcrypt.hash(password, 10);
        const userId = uuidv4();
        await pool.query(
            'INSERT INTO users (id, username, email, password_hash, created_at) VALUES ($1, $2, $3, $4, NOW())',
            [userId, username, normalizedEmail, hashed]
        );
        if (global.resetCodes) delete global.resetCodes[normalizedEmail];
        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/send-signup-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const normalizedEmail = email.toLowerCase().trim();
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        if (!global.resetCodes) global.resetCodes = {};
        global.resetCodes[normalizedEmail] = { code, expires: Date.now() + 10 * 60 * 1000 };
        await transporter.sendMail({
            from: `"Invigiflow" <${process.env.EMAIL_USER}>`,
            to: normalizedEmail,
            subject: 'Invigiflow Verification Code',
            html: `<p>Your verification code is: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
        });
        res.json({ message: 'Verification code sent.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send verification email' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    try {
        const result = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        if (!global.resetCodes) global.resetCodes = {};
        global.resetCodes[normalizedEmail] = { code, expires: Date.now() + 10 * 60 * 1000 };
        await transporter.sendMail({
            from: `"Invigiflow" <${process.env.EMAIL_USER}>`,
            to: normalizedEmail,
            subject: 'Password Reset Code',
            html: `<p>Your password reset code is: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
        });
        res.json({ message: 'Code sent to your email.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send reset email' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    if (!global.resetCodes || !global.resetCodes[normalizedEmail]) {
        return res.status(400).json({ error: 'No reset request found' });
    }
    const stored = global.resetCodes[normalizedEmail];
    if (stored.code !== code || Date.now() > stored.expires) {
        return res.status(400).json({ error: 'Invalid or expired code' });
    }
    try {
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hashed, normalizedEmail]);
        delete global.resetCodes[normalizedEmail];
        res.json({ message: 'Password reset successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
//  TEACHER ROUTES (with user_id)
// ============================================================

app.get('/api/teachers', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, subjects, years_at_school, teaching_hours FROM teachers WHERE user_id = $1',
            [req.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/teachers', authenticate, async (req, res) => {
    const { name, email, subjects, yearsAtSchool, teachingHours } = req.body;
    const id = uuidv4();
    try {
        await pool.query(
            `INSERT INTO teachers (id, user_id, name, email, subjects, years_at_school, teaching_hours)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, req.userId, name, email, JSON.stringify(subjects || []), yearsAtSchool || 0, teachingHours || 0]
        );
        const newTeacher = { id, name, email, subjects: subjects || [], yearsAtSchool, teachingHours };
        res.status(201).json(newTeacher);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/teachers/:id', authenticate, async (req, res) => {
    const { name, email, subjects, yearsAtSchool, teachingHours } = req.body;
    try {
        const result = await pool.query(
            `UPDATE teachers SET name=$1, email=$2, subjects=$3, years_at_school=$4, teaching_hours=$5
             WHERE id=$6 AND user_id=$7 RETURNING *`,
            [name, email, JSON.stringify(subjects || []), yearsAtSchool || 0, teachingHours || 0, req.params.id, req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        const t = result.rows[0];
        res.json({
            id: t.id,
            name: t.name,
            email: t.email,
            subjects: t.subjects,
            yearsAtSchool: t.years_at_school,
            teachingHours: t.teaching_hours
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/teachers/:id', authenticate, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM teachers WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
//  EXAM WEEK ROUTES (store full week object as JSONB)
// ============================================================

app.get('/api/exam-weeks', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, week_data FROM exam_weeks WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );
        // Return the full objects (including id)
        const weeks = result.rows.map(row => ({
            id: row.id,
            ...row.week_data
        }));
        res.json(weeks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/exam-weeks', authenticate, async (req, res) => {
    const { name, startDate, endDate, timezone } = req.body;
    const id = uuidv4();
    const weekData = {
        name,
        startDate,
        endDate,
        timezone,
        exams: [],
        allocations: null,
        finalAllocations: null
    };
    try {
        await pool.query(
            'INSERT INTO exam_weeks (id, user_id, week_data, created_at) VALUES ($1, $2, $3, NOW())',
            [id, req.userId, JSON.stringify(weekData)]
        );
        res.status(201).json({ id, ...weekData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/exam-weeks/:id', authenticate, async (req, res) => {
    const { name, startDate, endDate, timezone, exams, allocations, finalAllocations } = req.body;
    try {
        // First fetch existing week data to merge with new fields
        const existing = await pool.query('SELECT week_data FROM exam_weeks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        const oldData = existing.rows[0].week_data;
        const updatedData = {
            ...oldData,
            name: name !== undefined ? name : oldData.name,
            startDate: startDate !== undefined ? startDate : oldData.startDate,
            endDate: endDate !== undefined ? endDate : oldData.endDate,
            timezone: timezone !== undefined ? timezone : oldData.timezone,
            exams: exams !== undefined ? exams : oldData.exams || [],
            allocations: allocations !== undefined ? allocations : oldData.allocations || null,
            finalAllocations: finalAllocations !== undefined ? finalAllocations : oldData.finalAllocations || null,
        };
        await pool.query(
            'UPDATE exam_weeks SET week_data = $1 WHERE id=$2 AND user_id=$3',
            [JSON.stringify(updatedData), req.params.id, req.userId]
        );
        res.json({ id: req.params.id, ...updatedData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/exam-weeks/:id', authenticate, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM exam_weeks WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- Note: exams are now stored inside exam_weeks.week_data, so we don't need separate tables for exams, allocations, availabilities.
// However, we keep the endpoints that the frontend expects:
// GET /api/exam-weeks/:weekId/exams
// POST /api/exams
// POST /api/availabilities
// POST /api/allocations
// GET /api/allocations/:examWeekId

// For simplicity, we can handle these by reading/writing the week_data JSONB.

app.get('/api/exam-weeks/:weekId/exams', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT week_data FROM exam_weeks WHERE id=$1 AND user_id=$2', [req.params.weekId, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        const data = result.rows[0].week_data;
        res.json(data.exams || []);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/exams', authenticate, async (req, res) => {
    const { examWeekId, subject, name, type, studentCount, start, end } = req.body;
    try {
        const result = await pool.query('SELECT week_data FROM exam_weeks WHERE id=$1 AND user_id=$2', [examWeekId, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        const data = result.rows[0].week_data;
        if (!data.exams) data.exams = [];
        const newExam = {
            id: uuidv4(),
            subject,
            name,
            type,
            studentCount,
            startTime: start,
            endTime: end,
        };
        data.exams.push(newExam);
        await pool.query('UPDATE exam_weeks SET week_data = $1 WHERE id=$2 AND user_id=$3', [JSON.stringify(data), examWeekId, req.userId]);
        res.status(201).json(newExam);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/availabilities', authenticate, async (req, res) => {
    // For simplicity, we store availabilities inside the user's week data? But we don't have a user-level store.
    // The app currently doesn't use availabilities beyond allocation, but we can store them in a separate table.
    // However, the allocation algorithm reads availability from STORE.availability, which is not persisted.
    // So we can skip this endpoint for now – it's not used for storage currently.
    // We'll just return a success.
    res.status(201).json({ message: 'Availability added (not persisted)' });
});

app.post('/api/allocations', authenticate, async (req, res) => {
    const { examWeekId, allocations } = req.body;
    try {
        const result = await pool.query('SELECT week_data FROM exam_weeks WHERE id=$1 AND user_id=$2', [examWeekId, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        const data = result.rows[0].week_data;
        data.allocations = allocations;
        await pool.query('UPDATE exam_weeks SET week_data = $1 WHERE id=$2 AND user_id=$3', [JSON.stringify(data), examWeekId, req.userId]);
        res.status(201).json({ message: 'Allocations saved' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/allocations/:examWeekId', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT week_data FROM exam_weeks WHERE id=$1 AND user_id=$2', [req.params.examWeekId, req.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam week not found' });
        const data = result.rows[0].week_data;
        res.json({ allocations: data.allocations || null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- Send email (general) ----
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

app.get('/', (req, res) => {
    res.redirect('https://syt6099.github.io/Invigiflow/login.html');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
