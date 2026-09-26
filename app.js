require('dotenv').config({
    path: process.env.NODE_ENV === 'development' ? '.env.development' : '.env',
});
const express    = require('express');
const session    = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path       = require('path');
const fs         = require('fs');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const cors         = require('cors');
const db           = require('./app/config/db');
const i18n         = require('./app/config/i18n');
const { limiterGeral } = require('./app/middleware/rateLimits');

const app  = express();
const port = 3000;

// Garante que o diretório de uploads existe
const uploadDir = path.join(__dirname, 'uploads', 'profile_photos');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ===========================
// SEGURANÇA — HEADERS
// ===========================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com",
                "https://js.hcaptcha.com",
                "https://challenges.cloudflare.com",
                "https://unpkg.com",
                "https://code.jquery.com",
                "https://cdn.jsdelivr.net",
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com",
                "https://fonts.gstatic.com",
                "https://unpkg.com",
            ],
            imgSrc: [
                "'self'",
                "data:",
                "blob:",
                "https://res.cloudinary.com",
                "https://viacep.com.br",
                "https://*.tile.openstreetmap.org",
                "https://images.openfoodfacts.org",
                "https://cdn-cosmos.bluesoft.com.br",
            ],
            mediaSrc: [
                "'self'",
                "https://res.cloudinary.com",
                "blob:",
                "data:",
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com",
            ],
            connectSrc: [
                "'self'",
                "https://viacep.com.br",
                "https://api.workoutxapp.com",
                "https://overpass-api.de",
                "https://nominatim.openstreetmap.org",
            ],
            frameSrc: [
                "https://challenges.cloudflare.com",
                "https://js.hcaptcha.com",
            ],
            // html5-qrcode (scanner de barcode) roda a decodificação num
            // Worker criado via blob: — sem isso o worker-src cai pro
            // script-src, que não libera blob:, e o scanner falha calado.
            workerSrc: ["'self'", "blob:"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// FIX TEMPORÁRIO — força CSP correto, causa raiz não identificada a tempo
// do ExpoTech (investigar depois). Em produção o header Content-Security-Policy
// que chega no navegador não bate com o que o helmet() acima configura (só
// "upgrade-insecure-requests" sobrevive, sem script-src/default-src/etc), mas
// nenhuma segunda ocorrência de helmet/contentSecurityPolicy foi encontrada no
// código. Intercepta res.writeHead pra sobrescrever o header no exato momento
// em que a resposta é enviada, depois de qualquer outra coisa que hoje mexa nele.
const CSP_FORCADO = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://js.hcaptcha.com https://challenges.cloudflare.com https://unpkg.com https://code.jquery.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com",
    "img-src 'self' data: blob: https://res.cloudinary.com https://viacep.com.br https://*.tile.openstreetmap.org https://images.openfoodfacts.org https://cdn-cosmos.bluesoft.com.br",
    "media-src 'self' https://res.cloudinary.com blob: data:",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com",
    "connect-src 'self' https://viacep.com.br https://api.workoutxapp.com https://overpass-api.de https://nominatim.openstreetmap.org",
    "frame-src https://challenges.cloudflare.com https://js.hcaptcha.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "upgrade-insecure-requests",
].join('; ');

app.use((req, res, next) => {
    const originalWriteHead = res.writeHead;
    res.writeHead = function (...args) {
        res.setHeader('Content-Security-Policy', CSP_FORCADO);
        return originalWriteHead.apply(res, args);
    };
    next();
});

// ===========================
// CORS
// ===========================
const allowedOrigins = [
    'http://localhost:3000',
    'https://fitcrew.net',
    'https://www.fitcrew.net',
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('CORS: origem não permitida'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ===========================
// RATE LIMIT GERAL
// ===========================
app.use(limiterGeral);

// ===========================
// MIDDLEWARES
// ===========================
app.use(express.static("app/public"));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set("view engine", "ejs");
app.set("views", "./app/views");

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Em produção (HTTPS atrás de proxy), o Express precisa confiar no X-Forwarded-* do proxy
app.set('trust proxy', 1);

const sessionStore = new MySQLStore({
    createDatabaseTable:     false,
    clearExpired:            true,
    checkExpirationInterval: 1000 * 60 * 60,        // limpar expiradas a cada 1h
    expiration:              1000 * 60 * 60 * 24 * 30, // 30 dias
    connectionLimit:         1,
}, db);

// Extraído em variável — reaproveitado pelo WebSocket do chat pra autenticar
// via sessão (mesmo cookie), sem precisar duplicar a config.
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'gymbrossecret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge:   1000 * 60 * 60 * 24 * 30, // 30 dias
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    },
});
app.use(sessionMiddleware);

app.use(cookieParser());

// i18n: detecta locale pelo cookie gymbros_lang, expõe __() em todas as views
app.use(i18n.init);

// Injeta baseUrl em todas as views (canonical + OG)
app.use((req, res, next) => {
    res.locals.baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    next();
});

// Expõe sessão do usuário em todas as views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Injeta app_config em todas as views (cache de 60s)
let configCache = null;
let configCacheTime = 0;
app.use(async (req, res, next) => {
    try {
        const now = Date.now();
        if (!configCache || now - configCacheTime > 60000) {
            const [rows] = await db.execute('SELECT chave, valor FROM app_config');
            configCache = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
            configCacheTime = now;
        }
        res.locals.config = configCache;
    } catch {
        res.locals.config = {};
    }
    next();
});

// F14 — bloqueia navegação de contas suspensas/banidas (exceto login/apelação/painéis)
app.use(require('./app/middleware/checkContaSuspensa'));

const rotas = require('./app/routes/router');
app.use('/', rotas);

const rotasAI = require('./app/routes/ai');
app.use('/ai', rotasAI);

const rotasAPI = require('./app/routes/api');
app.use('/api', rotasAPI);

const rotasAdmin = require('./app/routes/admin');
app.use('/admin', rotasAdmin);

const rotasAdminAPI = require('./app/routes/admin-api');
app.use('/api/admin', rotasAdminAPI);

const rotasSuporte = require('./app/routes/suporte');
app.use('/api/suporte', rotasSuporte);

const rotasPush = require('./app/routes/push');
app.use('/push', rotasPush);
app.use('/internal/push', rotasPush);

const rotasGymAdmin = require('./app/routes/gymAdmin');
app.use('/gym-admin', rotasGymAdmin);

const rotasMod = require('./app/routes/mod');
app.use('/mod', rotasMod);

const server = app.listen(port, () => {
  console.log(`Servidor ouvindo na porta ${port}\nhttp://localhost:${port}`);
});

const { iniciarChatWs } = require('./app/services/chatWs');
iniciarChatWs(server, sessionMiddleware);
