const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const caCert = fs.readFileSync(path.join(__dirname, 'ca.pem')).toString();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: true,    // enforce certificate validation
        ca: caCert,                  // use the CA cert from Aiven
    }
});

module.exports = pool;
