'use strict';
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const mysql = require('mysql2/promise');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'exercisedb.p.rapidapi.com';
const CURSOR_FILE   = path.join(__dirname, '.fix-cursor.json');
const BATCH_SIZE    = 10;
const DELAY_MS      = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchExercise(id) {
    const paddedId = String(id).padStart(4, '0');
    const url = `https://${RAPIDAPI_HOST}/exercises/exercise/${paddedId}`;
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    resolve(body);
                } catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

function loadCursor() {
    try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); }
    catch { return { lastProcessedIndex: -1 }; }
}

function saveCursor(data) {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify(data, null, 2));
}

async function main() {
    const conn = await mysql.createConnection({
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port:     Number(process.env.DB_PORT) || 3306,
        timezone: '-03:00',
    });
    console.log('[fix-names] Conectado ao MySQL');

    try {
        const [placeholders] = await conn.execute(
            "SELECT id FROM exercises WHERE name LIKE 'Exercise %' ORDER BY id ASC"
        );
        const total = placeholders.length;
        console.log(`[fix-names] ${total} exercícios com nome placeholder\n`);

        if (total === 0) { console.log('[fix-names] Nada a fazer.'); return; }

        const cursor = loadCursor();
        const startIndex = cursor.lastProcessedIndex + 1;

        if (startIndex >= total) {
            console.log('[fix-names] Todos já processados (cursor no fim). Delete .fix-cursor.json para reiniciar.');
            return;
        }

        const remaining = placeholders.slice(startIndex, startIndex + BATCH_SIZE);
        console.log(`[fix-names] Processando índices ${startIndex}–${startIndex + remaining.length - 1} de ${total - 1}\n`);

        let lastIndex = startIndex - 1;

        for (let i = 0; i < remaining.length; i++) {
            const { id } = remaining[i];
            const globalIndex = startIndex + i;
            const numericId = parseInt(id, 10);

            try {
                const ex = await fetchExercise(numericId);

                if (!ex || ex.message || !ex.name) {
                    console.log(`[${globalIndex + 1}/${total}] ${id} → NOT FOUND (${JSON.stringify(ex).slice(0, 80)})`);
                    lastIndex = globalIndex;
                    saveCursor({ lastProcessedIndex: lastIndex });
                    if (i < remaining.length - 1) await sleep(DELAY_MS);
                    continue;
                }

                const name        = ex.name;
                const bodyPart    = (ex.bodyPart   ?? '').toLowerCase() || null;
                const target      = (ex.target     ?? '').toLowerCase() || null;
                const equipment   = (ex.equipment  ?? '').toLowerCase() || null;
                const instructions = Array.isArray(ex.instructions) ? JSON.stringify(ex.instructions) : null;

                await conn.execute(
                    `UPDATE exercises
                     SET name = ?, body_part = ?, target_muscle = ?, equipment_name = ?, instructions_json = ?
                     WHERE id = ?`,
                    [name, bodyPart, target, equipment, instructions, id]
                );

                console.log(`[${globalIndex + 1}/${total}] ${id} → ${name} — ok`);
            } catch (err) {
                console.error(`[${globalIndex + 1}/${total}] ${id} → ERRO: ${err.message}`);
            }

            lastIndex = globalIndex;
            saveCursor({ lastProcessedIndex: lastIndex });

            if (i < remaining.length - 1) await sleep(DELAY_MS);
        }

        const remaining2 = total - (lastIndex + 1);
        console.log(`\n[fix-names] Batch concluído. Faltam ${remaining2} exercício(s).`);
        if (remaining2 > 0) {
            console.log('[fix-names] Rode novamente para continuar do próximo batch.');
        } else {
            console.log('[fix-names] Todos os exercícios processados!');
        }
    } finally {
        await conn.end();
        console.log('[fix-names] Conexão encerrada.');
    }
}

main().catch(err => {
    console.error('[fix-names] Erro fatal:', err.message);
    process.exit(1);
});
