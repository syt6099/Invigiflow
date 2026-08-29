require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const pool = require('./db');

const DATA_DIR = path.join(__dirname, 'data');

async function readJSON(file) {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
}

async function migrate() {
    console.log('Starting migration...');
    try {
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
        for (const t of teachers) {
            // The JSON has 'id', 'name', 'email', 'subjects', 'yearsAtSchool', 'teachingHours'
            // We need a user_id – we'll assume the first user (or you can map)
            // For simplicity, we assign to the first user (if any)
            const userResult = await pool.query('SELECT id FROM users LIMIT 1');
            if (userResult.rows.length === 0) {
                console.warn('No users found, skipping teacher migration.');
                break;
            }
            const userId = userResult.rows[0].id;
            await pool.query(
                `INSERT INTO teachers (id, user_id, name, email, subjects, years_at_school, teaching_hours)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
                [t.id, userId, t.name, t.email || '', JSON.stringify(t.subjects || []), t.yearsAtSchool || 0, t.teachingHours || 0]
            );
        }
        console.log(`Migrated ${teachers.length} teachers.`);

        // 3. Exam Weeks (with embedded exams, allocations, etc.)
        const weeks = await readJSON(path.join(DATA_DIR, 'examWeeks.json'));
        for (const w of weeks) {
            const userResult = await pool.query('SELECT id FROM users LIMIT 1');
            if (userResult.rows.length === 0) break;
            const userId = userResult.rows[0].id;
            // Build the week_data object (without the id field)
            const { id, ...weekData } = w; // remove id from data
            await pool.query(
                `INSERT INTO exam_weeks (id, user_id, week_data, created_at)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
                [id, userId, JSON.stringify(weekData), w.createdAt || new Date().toISOString()]
            );
        }
        console.log(`Migrated ${weeks.length} exam weeks.`);

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
