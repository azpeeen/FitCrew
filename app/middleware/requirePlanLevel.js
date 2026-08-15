'use strict';

const db = require('../config/db');

// slugs: string[] — ex: ['gymbro', 'black']
// Verifica se o aluno tem acesso via:
//   1. Contrato ativo da academia do aluno (B2B) → libera independente de user_plan
//   2. planoSlug do usuário na sessão
function requirePlanLevel(slugs) {
    return async (req, res, next) => {
        const user = req.session.user;
        if (!user) return res.redirect('/login');

        // Verificação B2B: academia do aluno tem contrato ativo?
        if (user.gym_id) {
            try {
                const [[{ hasContract }]] = await db.execute(
                    'SELECT COUNT(*) AS hasContract FROM gym_contract WHERE gym_id = ? AND ativo = 1',
                    [user.gym_id]
                );
                if (hasContract > 0) return next();
            } catch (err) {
                console.error('[requirePlanLevel] b2b check:', err.message);
            }
        }

        // Fallback: verificação individual de plano
        const userSlug = user.planoSlug;
        if (!slugs.includes(userSlug)) {
            return res.redirect('/meu-plano?upgrade=1');
        }
        next();
    };
}

module.exports = requirePlanLevel;
