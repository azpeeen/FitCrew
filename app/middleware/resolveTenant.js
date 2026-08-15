'use strict';

// Stub: resolve gym_id da sessão do gestor.
// Futuramente suportará subdomínio (panobianco.gymbros.app.br).
function resolveTenant(req, res, next) {
    req.gymId = req.session.gymAdmin?.gym_id || null;
    next();
}

module.exports = resolveTenant;
