'use strict';

const db = require('../config/db');

// Prefixos que nunca são interceptados — precisam continuar acessíveis mesmo
// com a conta suspensa/banida (login, apelação, e os painéis de admin/mod que
// usam sessões inteiramente separadas de req.session.user).
const EXCLUDED_PREFIXES = [
    '/login',
    '/logout',
    '/register',
    '/conta-suspensa',
    '/conta-banida',
    '/api/apelacao',
    '/mod',
    '/admin',
    '/api/admin',
    '/api/suporte',
    '/gym-admin',
    '/push',
    '/internal/push',
];

function isExcluded(path) {
    return EXCLUDED_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
}

// Roda em toda a aplicação (registrado antes de qualquer router). Confia nos
// dados da sessão (populados no login) em vez de consultar o banco a cada
// request — o pool tem connectionLimit=1, então uma query extra por request
// autenticado seria um gargalo. Só consulta o banco no caminho raro (usuário
// suspenso/banido) para reativar suspensões vencidas.
module.exports = async function checkContaSuspensa(req, res, next) {
    const user = req.session && req.session.user;
    if (!user || !user.status_conta || user.status_conta === 'ativo') return next();
    if (isExcluded(req.path)) return next();

    const isApi = req.path.startsWith('/api/');

    if (user.status_conta === 'suspenso') {
        const ate = user.suspenso_ate ? new Date(user.suspenso_ate) : null;
        if (ate && ate > new Date()) {
            if (isApi) {
                return res.status(403).json({
                    ok: false,
                    erro: 'conta_suspensa',
                    suspenso_ate: user.suspenso_ate,
                    motivo: user.motivo_suspensao,
                });
            }
            return res.render('pages/conta-suspensa', {
                user,
                motivo: user.motivo_suspensao,
                suspenso_ate: user.suspenso_ate,
                seo: { title: 'Conta suspensa', robots: 'noindex' },
            });
        }
        // Suspensão vencida — reativa e segue o request normalmente.
        try {
            await db.execute(
                "UPDATE user SET status_conta = 'ativo', suspenso_ate = NULL, motivo_suspensao = NULL WHERE id = ?",
                [user.id],
            );
        } catch (err) {
            console.error('[checkContaSuspensa] reativação:', err.message);
        }
        user.status_conta = 'ativo';
        user.suspenso_ate = null;
        user.motivo_suspensao = null;
        return next();
    }

    if (user.status_conta === 'banido') {
        if (isApi) {
            return res.status(403).json({
                ok: false,
                erro: 'conta_banida',
                motivo: user.motivo_suspensao,
            });
        }
        return res.render('pages/conta-banida', {
            user,
            motivo: user.motivo_suspensao,
            seo: { title: 'Conta banida', robots: 'noindex' },
        });
    }

    next();
};
