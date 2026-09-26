'use strict';
require('dotenv').config();
const db = require('../app/config/db');

const migrations = [
    {
        name: 'user.senha_hash → CHAR(60)',
        sql: 'ALTER TABLE `user` MODIFY COLUMN `senha_hash` CHAR(60) NOT NULL',
    },
    {
        name: 'admin_user.senha_hash → CHAR(60)',
        sql: 'ALTER TABLE `admin_user` MODIFY COLUMN `senha_hash` CHAR(60) NOT NULL',
    },
];

async function run() {
    for (const m of migrations) {
        try {
            await db.execute(m.sql);
            console.log(`[ok] "${m.name}" alterado.`);
        } catch (err) {
            console.error(`[erro] ${m.name}:`, err.message);
        }
    }
    await db.end();
    console.log('[done] Migração concluída.');
}

run();
