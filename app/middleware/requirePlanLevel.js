'use strict';

const db = require('../config/db');

// slugs: string[] — ex: ['gymbro', 'black']
// Verifica se o aluno tem acesso via:
//   1. Contrato ativo da academia do aluno (B2B) → libera independente de user_plan
//   2. planoSlug do usuário na sessão
// Mesma regra do middleware, em forma de predicado — pra rotas JSON que precisam
// checar acesso depois de ler o corpo da requisição (ex: gate que depende do tipo).
async function temAcessoAoPlano(user, slugs) {
    if (!user) return false;

    // ExpoTech (temporário): DISABLE_PLAN_GATES=true libera qualquer nível de
    // plano. Reverter apagando a env var (ou setando =false) após o evento.
    if (process.env.DISABLE_PLAN_GATES === 'true') return true;

    // Verificação B2B: academia do aluno tem contrato ativo?
    if (user.gym_id) {
        try {
            const [[{ hasContract }]] = await db.execute(
                'SELECT COUNT(*) AS hasContract FROM gym_contract WHERE gym_id = ? AND ativo = 1',
                [user.gym_id]
            );
            if (hasContract > 0) return true;
        } catch (err) {
            console.error('[requirePlanLevel] b2b check:', err.message);
        }
    }

    // Fallback: verificação individual de plano
    return slugs.includes(user.planoSlug);
}

function requirePlanLevel(slugs) {
    return async (req, res, next) => {
        const user = req.session.user;
        if (!user) return res.redirect('/login');

        if (await temAcessoAoPlano(user, slugs)) return next();

        return res.redirect('/meu-plano?upgrade=1');
    };
}

module.exports = requirePlanLevel;
module.exports.temAcessoAoPlano = temAcessoAoPlano;
