'use strict';

const db = require('../config/db');
const { emitToUser } = require('../events');

// Recalcula e atualiza a pontuação de um membro num gymsquad (sempre no servidor).
async function recalcularPontuacao(gymsquadId, userId) {
    const [[gymsquad]] = await db.execute(
        'SELECT tipo_desafio, data_inicio, data_fim FROM gymsquad WHERE id = ? AND status = "ativo"',
        [gymsquadId]
    );
    if (!gymsquad) return;

    const { tipo_desafio, data_inicio, data_fim } = gymsquad;
    let pontuacao = 0;

    try {
        if (tipo_desafio === 'frequencia') {
            const [[{ total }]] = await db.execute(
                `SELECT COUNT(*) AS total FROM treino_checkins
                 WHERE user_id = ? AND DATE(created_at) BETWEEN ? AND ?`,
                [userId, data_inicio, data_fim]
            );
            pontuacao = total;

        } else if (tipo_desafio === 'carga') {
            // Sem coluna de repetições no schema real — aproxima usando
            // series_realizadas × carga_usada (parseada como número), mesma
            // convenção já usada em verificarConsistencia/conquistas.
            const [linhas] = await db.execute(
                `SELECT tse.series_realizadas, tse.carga_usada
                 FROM treino_sessao_exercicio tse
                 JOIN treino_sessao ts ON ts.id = tse.sessao_id
                 WHERE ts.user_id = ? AND ts.status = 'completo' AND tse.concluido = 1
                   AND DATE(ts.finalizado_em) BETWEEN ? AND ?`,
                [userId, data_inicio, data_fim]
            );
            pontuacao = linhas.reduce((soma, l) => {
                const peso = parseFloat(String(l.carga_usada || '').replace(/[^\d.]/g, '')) || 0;
                return soma + (l.series_realizadas || 0) * peso;
            }, 0);

        } else if (tipo_desafio === 'tempo') {
            const [[{ total }]] = await db.execute(
                `SELECT COALESCE(SUM(TIMESTAMPDIFF(MINUTE, iniciado_em, finalizado_em)), 0) AS total
                 FROM treino_sessao
                 WHERE user_id = ? AND status = 'completo'
                   AND DATE(finalizado_em) BETWEEN ? AND ?`,
                [userId, data_inicio, data_fim]
            );
            pontuacao = total;

        } else if (tipo_desafio === 'distancia') {
            // Km auto-declarado pelo membro (sem GPS) — ver gymsquad_distancia.
            const [[{ total }]] = await db.execute(
                `SELECT COALESCE(SUM(km), 0) AS total
                 FROM gymsquad_distancia
                 WHERE gymsquad_id = ? AND user_id = ? AND data BETWEEN ? AND ?`,
                [gymsquadId, userId, data_inicio, data_fim]
            );
            pontuacao = total;

        } else if (tipo_desafio === 'personalizado') {
            const [[{ total }]] = await db.execute(
                `SELECT COUNT(*) AS total
                 FROM gymsquad_post gp
                 JOIN post p ON p.id = gp.post_id
                 WHERE gp.gymsquad_id = ?
                   AND p.user_id = ?
                   AND p.status = 'ativo'
                   AND DATE(p.created_at) BETWEEN ? AND ?`,
                [gymsquadId, userId, data_inicio, data_fim]
            );
            pontuacao = total;
        }
    } catch (err) {
        console.error('[gymsquadPontuacao] recalcularPontuacao:', err.message);
        return;
    }

    await db.execute(
        'UPDATE gymsquad_membro SET pontuacao = ? WHERE gymsquad_id = ? AND user_id = ?',
        [pontuacao, gymsquadId, userId]
    );
}

// Busca o placar completo de um gymsquad, ordenado por pontuação.
async function buscarPlacar(gymsquadId) {
    const [placar] = await db.execute(
        `SELECT gm.user_id, gm.pontuacao, gm.role,
                u.nome, u.username, u.profile_photo AS foto_perfil
         FROM gymsquad_membro gm
         JOIN user u ON u.id = gm.user_id
         WHERE gm.gymsquad_id = ?
         ORDER BY gm.pontuacao DESC, u.nome ASC`,
        [gymsquadId]
    );
    return placar;
}

// Busca o placar e empurra pra todos os membros conectados via SSE.
async function pushPlacar(gymsquadId) {
    const placar = await buscarPlacar(gymsquadId);
    const [membros] = await db.execute(
        'SELECT user_id FROM gymsquad_membro WHERE gymsquad_id = ?',
        [gymsquadId]
    );
    membros.forEach(({ user_id }) => {
        emitToUser(user_id, 'gymsquad_placar', { gymsquad_id: gymsquadId, placar });
    });
    return placar;
}

// Chamado após check-in ou fim de sessão de treino: recalcula os gymsquads
// ativos do usuário cujo tipo depende desses eventos (não personalizado/distancia,
// que têm seus próprios gatilhos) e propaga o placar atualizado.
async function atualizarGymSquadsUsuario(userId) {
    try {
        const [gymsquads] = await db.execute(
            `SELECT gm.gymsquad_id FROM gymsquad_membro gm
             JOIN gymsquad g ON g.id = gm.gymsquad_id
             WHERE gm.user_id = ? AND g.status = 'ativo'
               AND CURDATE() BETWEEN g.data_inicio AND g.data_fim
               AND g.tipo_desafio IN ('frequencia', 'carga', 'tempo')`,
            [userId]
        );
        for (const { gymsquad_id } of gymsquads) {
            await recalcularPontuacao(gymsquad_id, userId);
            await pushPlacar(gymsquad_id);
        }
    } catch (err) {
        console.error('[gymsquadPontuacao] atualizarGymSquadsUsuario:', err.message);
    }
}

module.exports = { recalcularPontuacao, buscarPlacar, pushPlacar, atualizarGymSquadsUsuario };
