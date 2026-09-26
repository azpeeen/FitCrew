'use strict';
const mysql = require('mysql2/promise');

const connectionLimit = Number(process.env.DB_CONNECTION_LIMIT) || 1;

const pool = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    timezone: '-03:00',
    connectTimeout: 30000,
    idleTimeout:    300000,
    maxIdle:        connectionLimit,
});

pool.getConnection()
    .then(conn => {
        const alvo = process.env.NODE_ENV === 'development' ? 'LOCAL' : 'Clever Cloud';
        console.log(`[db] Conectado ao MySQL — ${alvo}`);
        conn.release();
    })
    .catch(err => console.error('[db] Erro de conexão:', err.message));

module.exports = pool;
