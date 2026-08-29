require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const pool = require('./db');

const DATA_DIR = path.join(__dirname, 'data');

async function readJSON(file) {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
}

async function createTables() {
    console.log('Creating tables if they do not exist...');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS teachers (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            email TEXT,
            subjects JSONB,
            years_at_school INT,
            teaching_hours INT
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS exam_weeks (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            week_data JSONB NOT NULL,
            created_at TIMESTAMP
        );
    `);
    console.log('Tables created (or already exist).');
}

async function migrate() {
    console.log('Starting migration...');
    try {
        await createTables();

        // 1. Users
        const users = await readJSON(path.join(DATA_DIR, 'users.json'));
        for (const user of users) {
            await pool.query(
                `INSERT INTO users (id, username, email, password_hash, created_at)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
                [user.id, user.username, user.email, user.passwordHash, user.createdAt]
            );
        }
        console.log(`Migrated ${users.length} users.`);

        // 2. Teachers
        const teachers = await readJSON(path.join(DATA_DIR, 'teachers.json'));
        const userResult = await pool.query('SELECT id FROM users LIMIT 1');
        const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;
        if (!userId) {
            console.warn('No users found; skipping teacher migration.');
        } else {
            for (const t of teachers) {
                await pool.query(
                    `INSERT INTO teachers (id, user_id, name, email, subjects, years_at_school, teaching_hours)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
                    [t.id, userId, t.name, t.email || '', JSON.stringify(t.subjects || []), t.yearsAtSchool || 0, t.teachingHours || 0]
                );
            }
            console.log(`Migrated ${teachers.length} teachers.`);
        }

        // 3. Exam Weeks
        const weeks = await readJSON(path.join(DATA_DIR, 'examWeeks.json'));
        if (userId) {
            for (const w of weeks) {
                const { id, ...weekData } = w;
                await pool.query(
                    `INSERT INTO exam_weeks (id, user_id, week_data, created_at)
                     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
                    [id, userId, JSON.stringify(weekData), w.createdAt || new Date().toISOString()]
                );
            }
            console.log(`Migrated ${weeks.length} exam weeks.`);
        }

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
