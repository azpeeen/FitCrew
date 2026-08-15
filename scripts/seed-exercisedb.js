'use strict';
/**
 * Seed WorkoutX → exercises + exercise_media
 * Uso: node scripts/seed-exercisedb.js
 * Persiste offset em scripts/.seed-cursor.json entre rodadas.
 */
require('dotenv').config();

const mysql      = require('mysql2/promise');
const cloudinary = require('cloudinary').v2;
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const WORKOUTX_KEY      = process.env.WORKOUTX_KEY;
const WORKOUTX_BASE     = 'https://api.workoutxapp.com/v1/exercises';
const PAGE_LIMIT        = 10;
const BATCH_SIZE        = 5;
const CLOUDINARY_FOLDER = 'gymbros/exercises';
const CURSOR_FILE       = path.join(__dirname, '.seed-cursor.json');

function loadOffset() {
    try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).offset ?? 0; }
    catch { return 0; }
}

function saveOffset(offset) {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ offset }), 'utf8');
}

function deleteCursor() {
    try { fs.unlinkSync(CURSOR_FILE); } catch {}
}

function fetchBuffer(url, extraHeaders = {}, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) return reject(new Error('Muitos redirects: ' + url));
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'FitCrew-Seed/1.0', ...extraHeaders }, rejectUnauthorized: false }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchBuffer(res.headers.location, {}, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(Object.assign(
                    new Error(`HTTP ${res.statusCode} em ${url}`),
                    { statusCode: res.statusCode }
                ));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end',  ()  => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function fetchPage(offset) {
    const url = `${WORKOUTX_BASE}?limit=${PAGE_LIMIT}&offset=${offset}`;
    return fetchBuffer(url, { 'X-WorkoutX-Key': WORKOUTX_KEY })
        .then(buf => {
            const body = JSON.parse(buf.toString('utf8'));
            return Array.isArray(body) ? body : (body.data ?? []);
        });
}

function uploadToCloudinary(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: CLOUDINARY_FOLDER, public_id: publicId, resource_type: 'image', format: 'gif', overwrite: true },
            (error, result) => { if (error) return reject(error); resolve(result.secure_url); }
        );
        stream.end(buffer);
    });
}

async function processOne(conn, ex, alreadyDone, index) {
    const exerciseId = String(ex.id ?? '').trim();
    const name       = String(ex.name ?? '').trim();
    const gifUrl     = String(ex.gifUrl ?? '').trim();

    if (!exerciseId || !name || !gifUrl) return 'skip';
    if (alreadyDone.has(exerciseId)) return 'skip';

    const bodyPart   = String(ex.bodyPart   ?? '').toLowerCase() || null;
    const target     = String(ex.target     ?? '').toLowerCase() || null;
    const equipment  = String(ex.equipment  ?? '').toLowerCase() || null;
    const instrucoes = Array.isArray(ex.instructions) ? JSON.stringify(ex.instructions) : null;

    let buffer;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            buffer = await fetchBuffer(gifUrl, { 'X-WorkoutX-Key': WORKOUTX_KEY });
            break;
        } catch (err) {
            if (err.statusCode === 429 && attempt < 3) {
                console.warn(`[${index}] ${name} — 429 no GIF, tentativa ${attempt}/3, aguardando 60s…`);
                await new Promise(r => setTimeout(r, 60_000));
            } else if (err.statusCode === 404) {
                console.warn(`[${index}] ${name} — sem GIF (404)`);
                return 'skip';
            } else {
                throw err;
            }
        }
    }
    if (!buffer) { console.error(`[${index}] ${name} — 429 após 3 tentativas`); return 'error'; }

    try {
        const cdnUrl = await uploadToCloudinary(buffer, `exercise_${exerciseId}`);

        await conn.execute(
            `INSERT IGNORE INTO exercises (id, name, body_part, target_muscle, equipment_name, instructions_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [exerciseId, name, bodyPart, target, equipment, instrucoes]
        );
        await conn.execute(
            'INSERT IGNORE INTO exercise_media (exercise_id, cloudinary_gif_url) VALUES (?, ?)',
            [exerciseId, cdnUrl]
        );

        alreadyDone.add(exerciseId);
        console.log(`[${index}] ${name} — ok | ${cdnUrl}`);
        return 'ok';
    } catch (err) {
        console.error(`[${index}] ${name} — ERRO: ${err.message}`);
        return 'error';
    }
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

    console.log('[seed] Conectado ao MySQL');

    try {
        const [mediaRows] = await conn.execute('SELECT exercise_id FROM exercise_media');
        const alreadyDone = new Set(mediaRows.map(r => r.exercise_id));

        let offset   = loadOffset();
        let success  = 0;
        let skipped  = 0;
        let failures = 0;
        let page     = 0;

        console.log(`[seed] Iniciando a partir do offset ${offset}…\n`);

        while (true) {
            let items;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    items = await fetchPage(offset);
                    break;
                } catch (err) {
                    if (err.statusCode === 429 && attempt < 3) {
                        console.warn(`[seed] 429 na página (tentativa ${attempt}/3) — aguardando 120s…`);
                        await new Promise(r => setTimeout(r, 120_000));
                    } else if (err.statusCode === 429) {
                        console.warn(`[seed] 429 após 3 tentativas — offset ${offset} salvo.`);
                        saveOffset(offset);
                        break;
                    } else {
                        throw err;
                    }
                }
            }
            if (!items) break;

            if (!Array.isArray(items) || items.length === 0) {
                console.log('[seed] Sem mais exercícios — seed completo!');
                deleteCursor();
                break;
            }

            page++;
            console.log(`[seed] Página ${page} (offset ${offset}) → ${items.length} exercícios`);

            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                const batch   = items.slice(i, i + BATCH_SIZE);
                const results = await Promise.allSettled(
                    batch.map((ex, j) => processOne(conn, ex, alreadyDone, offset + i + j + 1))
                );
                for (const r of results) {
                    const val = r.status === 'fulfilled' ? r.value : 'error';
                    if      (val === 'ok')   success++;
                    else if (val === 'skip') skipped++;
                    else                     failures++;
                }
            }

            offset += items.length;
            saveOffset(offset);
            await new Promise(r => setTimeout(r, 1_000));
        }

        const [[{ finalCount }]] = await conn.execute('SELECT COUNT(*) as finalCount FROM exercise_media');
        console.log(`\n[seed] Concluído.`);
        console.log(`  Uploads    : ${success}`);
        console.log(`  Pulados    : ${skipped}`);
        console.log(`  Falhas     : ${failures}`);
        console.log(`  No banco   : ${finalCount}`);
        console.log(`  Próx offset: ${offset}`);
    } finally {
        await conn.end();
        console.log('[seed] Conexão encerrada.');
    }
}

main().catch(err => {
    console.error('[seed] Erro fatal:', err.message);
    process.exit(1);
});
