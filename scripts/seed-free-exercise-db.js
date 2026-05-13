'use strict';
/**
 * Seed free-exercise-db → atualiza instructions_json + exercise_media
 * Uso: node scripts/seed-free-exercise-db.js
 * Fonte: https://github.com/yuhonas/free-exercise-db (Unlicense)
 * Faz fuzzy match pelo name contra a tabela exercises (Fuse.js, threshold 0.4).
 */
require('dotenv').config();

const mysql      = require('mysql2/promise');
const cloudinary = require('cloudinary').v2;
const https      = require('https');
const http       = require('http');
const Fuse       = require('fuse.js');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const JSON_URL          = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMAGE_BASE        = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';
const BATCH_SIZE        = 10;
const CLOUDINARY_FOLDER = 'gymbros/exercises';

function fetchBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) return reject(new Error('Muitos redirects: ' + url));
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'GymBros-Seed/1.0' }, rejectUnauthorized: false }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchBuffer(res.headers.location, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(Object.assign(new Error(`HTTP ${res.statusCode} em ${url}`), { statusCode: res.statusCode }));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function uploadToCloudinary(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: CLOUDINARY_FOLDER, public_id: publicId, resource_type: 'image', overwrite: false },
            (error, result) => { if (error) return reject(error); resolve(result.secure_url); }
        );
        stream.end(buffer);
    });
}

async function processOne(conn, ex, fuse, mediaSet, index, total) {
    const nome = String(ex.name || '').trim();
    if (!nome) return 'skip';

    const fuseResults = fuse.search(nome);
    if (!fuseResults.length) {
        console.log(`[${index}/${total}] ${nome} — sem match`);
        return 'skip';
    }

    const match     = fuseResults[0].item;
    const matchId   = match.id;
    const matchName = match.name;
    const actions   = [];

    // Atualiza instructions_json se estiver vazio
    if (!match.instructions_json || match.instructions_json === '[]' || match.instructions_json === '') {
        const instrucoes = Array.isArray(ex.instructions) ? ex.instructions.filter(Boolean) : [];
        if (instrucoes.length) {
            await conn.execute(
                `UPDATE exercises SET instructions_json = ?
                 WHERE id = ? AND (instructions_json IS NULL OR instructions_json = '' OR instructions_json = '[]')`,
                [JSON.stringify(instrucoes), matchId]
            );
            match.instructions_json = JSON.stringify(instrucoes);
            actions.push('instrucoes');
        }
    }

    // Upload de imagem se não houver entrada em exercise_media
    if (!mediaSet.has(String(matchId)) && Array.isArray(ex.images) && ex.images[0]) {
        const imgUrl = IMAGE_BASE + ex.images[0];
        try {
            const buffer = await fetchBuffer(imgUrl);
            const cdnUrl = await uploadToCloudinary(buffer, `exercise_${matchId}_free`);
            await conn.execute(
                'INSERT IGNORE INTO exercise_media (exercise_id, cloudinary_gif_url) VALUES (?, ?)',
                [matchId, cdnUrl]
            );
            mediaSet.add(String(matchId));
            actions.push('imagem');
        } catch (err) {
            console.warn(`[${index}/${total}] ${nome} — match: ${matchName} — erro imagem: ${err.message}`);
        }
    }

    const actionStr = actions.length ? actions.join('+') : 'já completo';
    console.log(`[${index}/${total}] ${nome} — match: ${matchName} — ${actionStr}`);
    return 'ok';
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

    console.log('[seed-free] Conectado ao MySQL');

    try {
        const [exerciseRows] = await conn.execute(
            'SELECT id, name, instructions_json FROM exercises'
        );
        if (!exerciseRows.length) {
            console.log('[seed-free] Tabela exercises vazia — rode seed-exercisedb.js primeiro');
            return;
        }

        const fuse = new Fuse(exerciseRows, {
            keys: ['name'],
            threshold: 0.4,
            includeScore: true,
        });

        const [mediaRows] = await conn.execute('SELECT exercise_id FROM exercise_media');
        const mediaSet    = new Set(mediaRows.map(r => String(r.exercise_id)));

        console.log(`[seed-free] ${exerciseRows.length} exercícios no banco, ${mediaSet.size} com mídia`);
        console.log('[seed-free] Baixando free-exercise-db…');

        const rawJson = await fetchBuffer(JSON_URL);
        const source  = JSON.parse(rawJson.toString('utf8'));
        const total   = source.length;

        console.log(`[seed-free] ${total} exercícios na fonte\n`);

        let success = 0, skipped = 0, failures = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch   = source.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map((ex, j) => processOne(conn, ex, fuse, mediaSet, i + j + 1, total))
            );
            for (const r of results) {
                const val = r.status === 'fulfilled' ? r.value : 'error';
                if      (val === 'ok')   success++;
                else if (val === 'skip') skipped++;
                else { failures++; if (r.reason) console.error('[seed-free] erro:', r.reason.message); }
            }
        }

        const [[{ total: mediaTotal }]] = await conn.execute(
            'SELECT COUNT(*) AS total FROM exercise_media'
        );
        console.log('\n[seed-free] Concluído.');
        console.log(`  Processados: ${success}`);
        console.log(`  Pulados    : ${skipped}`);
        console.log(`  Falhas     : ${failures}`);
        console.log(`  exercise_media total: ${mediaTotal}`);
    } finally {
        await conn.end();
        console.log('[seed-free] Conexão encerrada.');
    }
}

main().catch(err => {
    console.error('[seed-free] Erro fatal:', err.message);
    process.exit(1);
});
