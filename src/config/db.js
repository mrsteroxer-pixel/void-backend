// src/config/db.js
const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    }
  : {
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      false,
    };

const pool = new Pool({ ...poolConfig, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 });

pool.on('error', (err) => console.error('Unexpected DB pool error:', err));

pool.query('SELECT NOW()')
  .then(() => console.log('✓ Database connected'))
  .catch(err => { console.error('✗ Database connection failed:', err.message); process.exit(1); });

module.exports = pool;
