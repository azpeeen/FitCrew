'use strict';
const db = require('../config/db');

const BODY_PART_MAP = {
    'upper arms': 'braco',
    'chest':      'peito',
    'back':       'costas',
    'shoulders':  'ombro',
    'waist':      'core',
    'upper legs': 'perna',
    'lower legs': 'perna',
    'cardio':     'cardio',
};

async function desbloquearSeNecessario(userId, slug) {
    const [conquista] = await db.execute('SELECT id FROM conquistas WHERE slug = ?', [slug]);
    if (!conquista.length) return false;
    const conquistaId = conquista[0].id;
    const [result] = await db.execute(
        'INSERT IGNORE INTO usuario_conquistas (user_id, conquista_id) VALUES (?, ?)',
        [userId, conquistaId]
    );
    return result.affectedRows > 0;
}

async function verificarPeso(userId, bodyPart, pesoKg) {
    const categoriaMap = {
        'upper arms': 'braco',
        'lower arms': 'braco',
        'chest':      'peito',
        'back':       'costas',
        'shoulders':  'ombro',
        'waist':      'core',
        'upper legs': 'perna',
        'lower legs': 'perna',
        'cardio':     'cardio',
    };
    const categoria = categoriaMap[(bodyPart || '').toLowerCase()];
    if (!categoria) return [];

    const [conquistas] = await db.execute(`
        SELECT c.id, c.slug, c.meta_valor FROM conquistas c
        WHERE c.categoria = ?
          AND c.meta_tipo = 'peso'
          AND c.meta_valor <= ?
        ORDER BY c.meta_valor ASC
    `, [categoria, pesoKg]);

    if (!conquistas.length) return [];

    const slugs = [];
    for (const c of conquistas) {
        await db.execute(
            'INSERT IGNORE INTO usuario_conquistas (user_id, conquista_id) VALUES (?, ?)',
            [userId, c.id]
        );
        slugs.push(c.slug);
    }
    return slugs;
}

async function verificarCardio(userId, duracaoMinutos) {
    const slugs = ['cardio-bronze','cardio-prata','cardio-ouro','cardio-platina','cardio-diamante'];
    const [conquistas] = await db.execute(
        'SELECT slug, meta_valor FROM conquistas WHERE slug IN (?) ORDER BY meta_valor ASC',
        [slugs]
    );
    const desbloqueadas = [];
    for (const c of conquistas) {
        if (duracaoMinutos >= Number(c.meta_valor)) {
            const ok = await desbloquearSeNecessario(userId, c.slug);
            if (ok) desbloqueadas.push(c.slug);
        }
    }
    return desbloqueadas;
}

async function verificarConsistencia(userId) {
    const desbloqueadas = [];

    const [[{ total }]] = await db.execute(
        'SELECT COUNT(*) as total FROM treino_sessao WHERE user_id = ? AND status = "completo"',
        [userId]
    );
    if (total >= 1) {
        const ok = await desbloquearSeNecessario(userId, 'consist-bronze');
        if (ok) desbloqueadas.push('consist-bronze');
    }

    const [checkins] = await db.execute(
        'SELECT DATE(created_at) as dia FROM treino_checkins WHERE user_id = ? GROUP BY DATE(created_at) ORDER BY dia DESC',
        [userId]
    );

    let streak = 0;
    let diaAnterior = null;
    for (const row of checkins) {
        const dia = new Date(row.dia);
        if (!diaAnterior) {
            streak = 1;
        } else {
            const diff = (diaAnterior - dia) / (1000 * 60 * 60 * 24);
            if (diff === 1) streak++;
            else break;
        }
        diaAnterior = dia;
    }

    if (streak >= 3)  { const ok = await desbloquearSeNecessario(userId, 'consist-prata');   if (ok) desbloqueadas.push('consist-prata'); }
    if (streak >= 7)  { const ok = await desbloquearSeNecessario(userId, 'consist-platina');  if (ok) desbloqueadas.push('consist-platina'); }
    if (streak >= 30) { const ok = await desbloquearSeNecessario(userId, 'consist-diamante'); if (ok) desbloqueadas.push('consist-diamante'); }

    const [[{ semana }]] = await db.execute(
        'SELECT COUNT(*) as semana FROM treino_checkins WHERE user_id = ? AND YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)',
        [userId]
    );
    if (semana >= 5) {
        const ok = await desbloquearSeNecessario(userId, 'consist-ouro');
        if (ok) desbloqueadas.push('consist-ouro');
    }

    return desbloqueadas;
}

async function verificarIA(userId, tipo) {
    const slugMap = { treino: 'ia-treino', dieta: 'ia-dieta', avaliacao: 'ia-avaliacao' };
    const slug = slugMap[tipo];
    if (!slug) return [];
    const ok = await desbloquearSeNecessario(userId, slug);
    return ok ? [slug] : [];
}

async function getConquistasUsuario(userId) {
    const [todas] = await db.execute('SELECT * FROM conquistas ORDER BY categoria, meta_valor ASC');
    const [desbloqueadas] = await db.execute(
        'SELECT conquista_id, desbloqueada_em FROM usuario_conquistas WHERE user_id = ?',
        [userId]
    );
    const desbMap = {};
    desbloqueadas.forEach(d => { desbMap[d.conquista_id] = d.desbloqueada_em; });
    return todas.map(c => ({
        ...c,
        desbloqueada:    !!desbMap[c.id],
        desbloqueada_em: desbMap[c.id] || null,
    }));
}

module.exports = { verificarPeso, verificarCardio, verificarConsistencia, verificarIA, getConquistasUsuario };
