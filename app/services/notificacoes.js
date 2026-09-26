const db = require('../config/db');
const { emitToUser } = require('../events');

async function criarNotificacao(usuarioId, tipo, titulo, mensagem, dadosExtras) {
    try {
        const [r] = await db.execute(
            `INSERT INTO notificacao_social (usuario_id, tipo, titulo, mensagem, dados_extras)
             VALUES (?, ?, ?, ?, ?)`,
            [usuarioId, tipo, titulo, mensagem || null, dadosExtras ? JSON.stringify(dadosExtras) : null]
        );
        const notif = {
            id: r.insertId,
            tipo,
            titulo,
            mensagem: mensagem || null,
            dados_extras: dadosExtras || null,
            lida: 0,
            criado_em: new Date().toISOString(),
        };
        emitToUser(String(usuarioId), 'notificacao_social', { notificacao: notif });
        return notif;
    } catch (err) {
        console.error('[notificacoes] criarNotificacao:', err.message);
    }
}

module.exports = { criarNotificacao };
