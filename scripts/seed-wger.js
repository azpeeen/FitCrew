'use strict';
/**
 * Seed wger → atualiza instructions_json + exercise_media
 * Uso: node scripts/seed-wger.js
 *
 * Usa /exerciseinfo que embute translations[] e images[] por exercício.
 * Filtra apenas exercícios com tradução PT (language=7).
 * Fuzzy match pelo nome EN (language=2) contra a tabela exercises; fallback ao PT.
 * Fuse.js threshold 0.4 (igual ao ai.js).
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

const WGER_BASE         = 'https://wger.de/api/v2';
const BATCH_SIZE        = 10;
const CLOUDINARY_FOLDER = 'gymbros/exercises';

function stripHtml(html) {
    return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function fetchJson(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) return reject(new Error('Muitos redirects: ' + url));
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'GymBros-Seed/1.0' }, rejectUnauthorized: false }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchJson(res.headers.location, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(Object.assign(new Error(`HTTP ${res.statusCode} em ${url}`), { statusCode: res.statusCode }));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

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

async function fetchAllExercisesWithPt() {
    const all = [];
    let url = `${WGER_BASE}/exerciseinfo/?format=json&limit=100&offset=0`;
    let page = 0;
    while (url) {
        page++;
        const data = await fetchJson(url);
        if (Array.isArray(data.results)) {
            const withPt = data.results.filter(ex =>
                Array.isArray(ex.translations) && ex.translations.some(t => t.language === 7)
            );
            all.push(...withPt);
        }
        process.stdout.write(`\r[seed-wger] Paginando… página ${page} (${all.length} com PT)`);
        url = data.next || null;
        if (url) await new Promise(r => setTimeout(r, 400));
    }
    process.stdout.write('\n');
    return all;
}

async function processOne(conn, ex, fuse, mediaSet, index, total) {
    const ptTrans = ex.translations.find(t => t.language === 7);
    const enTrans = ex.translations.find(t => t.language === 2);
    const imgData = ex.images && ex.images[0];

    const nomePt      = String(ptTrans.name || '').trim();
    const nomeEn      = enTrans ? String(enTrans.name || '').trim() : null;
    const nomeMatch   = nomeEn || nomePt;
    const matchSource = nomeEn ? `EN:"${nomeEn}"` : `PT:"${nomePt}"`;

    const fuseResults = fuse.search(nomeMatch);
    if (!fuseResults.length) {
        console.log(`[${index}/${total}] ${nomePt} (${matchSource}) — sem match`);
        return 'skip';
    }

    const match     = fuseResults[0].item;
    const matchId   = match.id;
    const matchName = match.name;
    const actions   = [];

    // Atualiza instructions_json se estiver vazio — usa EN se disponível, senão PT
    if (!match.instructions_json || match.instructions_json === '[]' || match.instructions_json === '') {
        const rawDesc = enTrans ? enTrans.description : ptTrans.description;
        const texto   = stripHtml(rawDesc || '');
        if (texto) {
            await conn.execute(
                `UPDATE exercises SET instructions_json = ?
                 WHERE id = ? AND (instructions_json IS NULL OR instructions_json = '' OR instructions_json = '[]')`,
                [JSON.stringify([texto]), matchId]
            );
            match.instructions_json = JSON.stringify([texto]);
            actions.push('instrucoes');
        }
    }

    // Upload de imagem se não houver entrada em exercise_media
    if (!mediaSet.has(String(matchId)) && imgData && imgData.image) {
        try {
            const buffer = await fetchBuffer(imgData.image);
            const cdnUrl = await uploadToCloudinary(buffer, `exercise_${matchId}_wger`);
            await conn.execute(
                'INSERT IGNORE INTO exercise_media (exercise_id, cloudinary_gif_url) VALUES (?, ?)',
                [matchId, cdnUrl]
            );
            mediaSet.add(String(matchId));
            actions.push('imagem');
        } catch (err) {
            console.warn(`[${index}/${total}] ${nomePt} — match: ${matchName} — erro imagem: ${err.message}`);
        }
    }

    const actionStr = actions.length ? actions.join('+') : 'já completo';
    console.log(`[${index}/${total}] ${nomePt} (${matchSource}) — match: ${matchName} — ${actionStr}`);
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

    console.log('[seed-wger] Conectado ao MySQL');

    try {
        const [exerciseRows] = await conn.execute(
            'SELECT id, name, instructions_json FROM exercises'
        );
        if (!exerciseRows.length) {
            console.log('[seed-wger] Tabela exercises vazia — rode seed-exercisedb.js primeiro');
            return;
        }

        const fuse = new Fuse(exerciseRows, {
            keys: ['name'],
            threshold: 0.4,
            includeScore: true,
        });

        const [mediaRows] = await conn.execute('SELECT exercise_id FROM exercise_media');
        const mediaSet    = new Set(mediaRows.map(r => String(r.exercise_id)));

        console.log(`[seed-wger] ${exerciseRows.length} exercícios no banco, ${mediaSet.size} com mídia`);
        console.log('[seed-wger] Buscando exerciseinfo do wger…\n');

        const wgerExs = await fetchAllExercisesWithPt();
        const total   = wgerExs.length;
        console.log(`[seed-wger] ${total} exercícios com tradução PT encontrados\n`);

        let success = 0, skipped = 0, failures = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch   = wgerExs.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map((ex, j) => processOne(conn, ex, fuse, mediaSet, i + j + 1, total))
            );
            for (const r of results) {
                const val = r.status === 'fulfilled' ? r.value : 'error';
                if      (val === 'ok')   success++;
                else if (val === 'skip') skipped++;
                else { failures++; if (r.reason) console.error('[seed-wger] erro:', r.reason.message); }
            }
            await new Promise(r => setTimeout(r, 300));
        }

        const [[{ total: mediaTotal }]] = await conn.execute(
            'SELECT COUNT(*) AS total FROM exercise_media'
        );
        console.log('\n[seed-wger] Concluído.');
        console.log(`  Processados: ${success}`);
        console.log(`  Pulados    : ${skipped}`);
        console.log(`  Falhas     : ${failures}`);
        console.log(`  exercise_media total: ${mediaTotal}`);
    } finally {
        await conn.end();
        console.log('[seed-wger] Conexão encerrada.');
    }
}

main().catch(err => {
    console.error('[seed-wger] Erro fatal:', err.message);
    process.exit(1);
});
