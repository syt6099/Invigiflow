const { Pool } = require('pg');

// Strip sslmode query params so pg doesn't override rejectUnauthorized
const connectionString = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.split('?')[0]
    : '';

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

module.exports = pool;
