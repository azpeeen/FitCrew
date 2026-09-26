'use strict';
/**
 * Recupera exercises + exercise_media a partir dos GIFs já no Cloudinary.
 * Metadados buscados na ExerciseDB RapidAPI (IDs numéricos).
 * Uso: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/recover-from-cloudinary.js
 */
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const mysql      = require('mysql2/promise');
const cloudinary = require('cloudinary').v2;
const https      = require('https');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'exercisedb.p.rapidapi.com';

// ── Cloudinary: lista todos os recursos da pasta ──────────────────────────────
async function listAllCloudinaryResources() {
    const resources = [];
    let cursor = undefined;
    do {
        const opts = { type: 'upload', prefix: 'gymbros/exercises/', max_results: 500 };
        if (cursor) opts.next_cursor = cursor;
        const result = await new Promise((res, rej) =>
            cloudinary.api.resources(opts, (err, r) => err ? rej(err) : res(r))
        );
        resources.push(...result.resources);
        cursor = result.next_cursor;
        console.log(`[recover] Cloudinary: ${resources.length} recursos listados…`);
    } while (cursor);
    return resources;
}

// ── RapidAPI: busca metadados por offset ──────────────────────────────────────
function fetchRapidAPI(offset, limit = 100) {
    return new Promise((resolve, reject) => {
        const url = `https://${RAPIDAPI_HOST}/exercises?limit=${limit}&offset=${offset}`;
        https.get(url, {
            headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    resolve(Array.isArray(body) ? body : (body.data ?? []));
                } catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function fetchAllMetadata(ids) {
    const map = new Map(); // id → metadata
    const maxId = Math.max(...ids.map(id => parseInt(id, 10)));
    const pages  = Math.ceil((maxId + 1) / 100);

    for (let p = 0; p < pages; p++) {
        const offset = p * 100;
        try {
            const items = await fetchRapidAPI(offset, 100);
            for (const ex of items) {
                if (ex.id) map.set(ex.id, ex);
            }
            console.log(`[recover] RapidAPI offset ${offset}: ${items.length} exercícios (map size: ${map.size})`);
        } catch (err) {
            console.warn(`[recover] RapidAPI offset ${offset} falhou: ${err.message}`);
        }
    }
    return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const conn = await mysql.createConnection({
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port:     Number(process.env.DB_PORT) || 3306,
        timezone: '-03:00',
    });
    console.log('[recover] Conectado ao MySQL');

    try {
        // 1. Lista GIFs no Cloudinary
        const resources = await listAllCloudinaryResources();
        console.log(`[recover] Total no Cloudinary: ${resources.length} GIFs\n`);

        // extrai exerciseId do public_id (ex: "gymbros/exercises/exercise_0001" → "0001")
        const entries = resources.map(r => ({
            exerciseId: r.public_id.replace(/^.*\/exercise_/, ''),
            gifUrl:     r.secure_url,
        })).filter(e => e.exerciseId);

        // separa IDs numéricos e alfanuméricos (OSS)
        const numericIds = entries.filter(e => /^\d+$/.test(e.exerciseId)).map(e => e.exerciseId);
        console.log(`[recover] IDs numéricos: ${numericIds.length}, OSS/outros: ${entries.length - numericIds.length}`);

        // 2. Busca metadados na RapidAPI para IDs numéricos
        let metaMap = new Map();
        if (numericIds.length > 0 && RAPIDAPI_KEY) {
            metaMap = await fetchAllMetadata(numericIds);
        }

        // 3. Insere no banco
        let inserted = 0;
        let skipped  = 0;

        for (const { exerciseId, gifUrl } of entries) {
            const meta = metaMap.get(exerciseId);
            const name      = meta?.name      ?? `Exercise ${exerciseId}`;
            const bodyPart  = (meta?.bodyPart  ?? '').toLowerCase() || null;
            const target    = (meta?.target    ?? '').toLowerCase() || null;
            const equipment = (meta?.equipment ?? '').toLowerCase() || null;
            const instrucoes = Array.isArray(meta?.instructions) ? JSON.stringify(meta.instructions) : null;

            try {
                await conn.execute(
                    `INSERT IGNORE INTO exercises (id, name, body_part, target_muscle, equipment_name, instructions_json)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [exerciseId, name, bodyPart, target, equipment, instrucoes]
                );
                await conn.execute(
                    'INSERT IGNORE INTO exercise_media (exercise_id, cloudinary_gif_url) VALUES (?, ?)',
                    [exerciseId, gifUrl]
                );
                console.log(`  ✓ [${exerciseId}] ${name}`);
                inserted++;
            } catch (err) {
                console.error(`  ✗ [${exerciseId}] ERRO: ${err.message}`);
                skipped++;
            }
        }

        const [[{ total }]] = await conn.execute('SELECT COUNT(*) as total FROM exercise_media');
        console.log(`\n[recover] Concluído.`);
        console.log(`  Inseridos : ${inserted}`);
        console.log(`  Falhas    : ${skipped}`);
        console.log(`  No banco  : ${total}`);
    } finally {
        await conn.end();
        console.log('[recover] Conexão encerrada.');
    }
}

main().catch(err => {
    console.error('[recover] Erro fatal:', err.message);
    process.exit(1);
});
