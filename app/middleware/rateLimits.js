'use strict';
const rateLimit = require('express-rate-limit');

const skipDev = (req) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip === '127.0.0.1'
        || ip === '::1'
        || ip === '::ffff:127.0.0.1'
        || process.env.NODE_ENV === 'development';
};

// SSE (conexões persistentes) e polling automático não devem contar contra o
// limite geral de requisições — são chamados repetidamente por design.
const isRealtimePath = (req) => {
    const path = req.path || req.originalUrl || '';
    return path.includes('/stream')
        || path === '/api/posts/feed/novos'
        || path === '/api/notificacoes/sociais/count';
};

// Geral — páginas, APIs normais
// 600 req/15min = 40 req/min = suficiente pra SSE + polling + uso normal
const limiterGeral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => skipDev(req) || isRealtimePath(req),
    message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' },
});

// Login — mais restrito pra evitar brute force
// 20 tentativas/15min por IP
const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: skipDev,
    message: { erro: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

// Upload — foto, vídeo, story
// 30 uploads/hora
const limiterUpload = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipDev,
    message: { erro: 'Limite de uploads atingido. Tente novamente em 1 hora.' },
});

// SSE — Server-Sent Events (notificações, suporte)
// Não limita por req/s (a conexão fica aberta); limita reconexões: max 10/min por IP
const limiterSSE = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipDev,
    message: { erro: 'Muitas conexões simultâneas.' },
});

// API de busca — chamada com debounce, mas ainda assim precisa de folga
// 120 buscas/min
const limiterBusca = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipDev,
    message: { erro: 'Muitas buscas. Aguarde um momento.' },
});

module.exports = { limiterGeral, limiterLogin, limiterUpload, limiterSSE, limiterBusca };
