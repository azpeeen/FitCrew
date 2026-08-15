/**
 * admin.js — Rotas de página do painel administrativo GymBros
 */
'use strict';

const express   = require('express');
const router    = express.Router();
const bcrypt         = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const adminAuth      = require('../middleware/adminAuth');
const { limiterLogin } = require('../middleware/rateLimits');
const db             = require('../config/db');
const User           = require('../models/User');
const Plan           = require('../models/Plan');
const Gym            = require('../models/Gym');
const SupportTicket  = require('../models/SupportTicket');
const Notification   = require('../models/Notification');
const { sendBoasVindas, sendAlertaAdminNovaAcademia } = require('../services/emailGymAdmin');
const { decryptCpf } = require('../services/cripto');

// Descriptografa cpf_enc pra exibição no admin; nunca expõe cpf_enc/cpf_hmac brutos
function cpfDisplay(user) {
    if (user.cpf_enc) {
        const cpf = decryptCpf(user.cpf_enc);
        return cpf ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : '***.***.***-**';
    }
    return user.cpf ? user.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : '—';
}

function gerarSenha(len = 10) {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

// ── Helper: constrói adminConfig a partir de res.locals.config ───────────────
function buildAdminConfig(config = {}) {
    return {
        siteName:             config.siteName             || 'FitCrew',
        maintenance:          config.maintenance === 'true' || config.maintenance === true,
        version:              config.version              || '1.0.0',
        notifThresholdHours:  parseInt(config.notifThresholdHours) || 24,
    };
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
    if (req.session.admin) return res.redirect('/admin/dashboard');
    res.render('pages/admin-login', { erro: null, next: req.query.next || '/admin/dashboard' });
});

router.post('/login', limiterLogin, [
    body('email').isEmail().normalizeEmail().withMessage('E-mail inválido'),
    body('password').isLength({ min: 6 }).withMessage('Senha muito curta'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('pages/admin-login', { erro: errors.array()[0].msg, next: req.body.next || '/admin/dashboard' });
    }
    const { email, password } = req.body;
    try {
        const [rows] = await db.execute(
            'SELECT * FROM admin_user WHERE email = ? AND ativo = 1',
            [email]
        );
        const admin = rows[0];
        if (!admin || !(await bcrypt.compare(password, admin.senha_hash))) {
            return res.render('pages/admin-login', { erro: 'Credenciais inválidas.', next: req.body.next || '/admin/dashboard' });
        }
        req.session.admin = {
            id:    admin.id,
            nome:  admin.nome,
            email: admin.email,
            role:  admin.role,
        };
        await db.execute('UPDATE admin_user SET ultimo_login = NOW() WHERE id = ?', [admin.id]);
        const next = req.body.next || '/admin/dashboard';
        req.session.save(err => {
            if (err) {
                console.error('[admin/login] session save error:', err);
                return res.redirect('/admin/login?erro=1');
            }
            return res.redirect(next);
        });
    } catch (err) {
        console.error('[admin/login]', err);
        res.render('pages/admin-login', { erro: 'Erro interno. Tente novamente.', next: req.body.next || '/admin/dashboard' });
    }
});

router.get('/logout', (req, res) => {
    req.session.admin = null;
    res.redirect('/admin/login');
});

// ── Aplica adminAuth em tudo abaixo ──────────────────────────────────────────
router.use(adminAuth);

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
    try {
        const [[{ totalUsuarios }]] = await db.execute('SELECT COUNT(*) AS totalUsuarios FROM user');
        const [[{ ativosHoje }]]    = await db.execute("SELECT COUNT(*) AS ativosHoje FROM checkin WHERE DATE(data) = CURDATE()");
        const [[{ receitaMes }]]    = await db.execute(
            "SELECT COALESCE(SUM(valor_final),0) AS receitaMes FROM payment WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) AND status='pago'"
        );
        const [[{ ticketsAbertosN }]] = await db.execute(
            "SELECT COUNT(*) AS ticketsAbertosN FROM support_ticket WHERE status != 'resolvido'"
        );

        // Gráfico: cadastros por dia (30 dias)
        const [cadastrosRaw] = await db.execute(
            "SELECT DATE(created_at) AS dia, COUNT(*) AS total FROM user WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) GROUP BY DATE(created_at)"
        );
        const cadastrosMap = new Map(cadastrosRaw.map(r => [r.dia.toISOString().slice(0,10), Number(r.total)]));
        const labelsDias = [], cadastrosPorDia = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            labelsDias.push(`${d.getDate()}/${d.getMonth()+1}`);
            cadastrosPorDia.push(cadastrosMap.get(d.toISOString().slice(0,10)) || 0);
        }

        // Gráfico: checkins por dia da semana
        const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const [checkinsDia] = await db.execute(
            'SELECT (DAYOFWEEK(data)-1) AS dia, COUNT(*) AS total FROM checkin GROUP BY DAYOFWEEK(data)'
        );
        const checkinsPorDiaSemana = diasSemana.map((_, d) => {
            const r = checkinsDia.find(x => x.dia === d);
            return r ? Number(r.total) : 0;
        });

        const [ultimosCadastros] = await db.execute(
            'SELECT id, nome, email, cpf, status, created_at FROM user ORDER BY created_at DESC LIMIT 5'
        );
        const [ticketsUrgentes] = await db.execute(
            "SELECT * FROM support_ticket WHERE status = 'aberto' AND created_at < NOW() - INTERVAL 24 HOUR LIMIT 5"
        );

        const ticketCount  = Number(ticketsAbertosN);
        const adminConfig  = buildAdminConfig(res.locals.config);

        res.render('pages/admin-dashboard', {
            ticketCount, adminConfig,
            title: 'Dashboard', page: 'dashboard', admin: req.session.admin,
            totalUsuarios: Number(totalUsuarios), ativosHoje: Number(ativosHoje),
            receitaMes: Number(receitaMes).toFixed(2),
            ticketsAbertosN: ticketCount,
            labelsDias: JSON.stringify(labelsDias),
            cadastrosPorDia: JSON.stringify(cadastrosPorDia),
            diasSemana: JSON.stringify(diasSemana),
            checkinsPorDiaSemana: JSON.stringify(checkinsPorDiaSemana),
            ultimosCadastros,
            ticketsUrgentes,
        });
    } catch (err) {
        console.error('[admin/dashboard]', err);
        res.status(500).send('Erro ao carregar dashboard.');
    }
});

// ── USUÁRIOS ──────────────────────────────────────────────────────────────────
router.get('/usuarios', async (req, res) => {
    const { busca = '', plano = '', status = '' } = req.query;
    const perPage = 15;
    const pagina  = Math.floor(Number(req.query.page)) || 1;
    const filters = { status: status || null, busca: busca || null, plano: plano || null };
    try {
        const [items, total, planos, ticketCount] = await Promise.all([
            User.findAll({ page: pagina, limit: perPage, ...filters }),
            User.count(filters),
            Plan.findAll({ activeOnly: true }),
            SupportTicket.countOpen(),
        ]);
        const pages       = Math.ceil(total / perPage);
        const adminConfig = buildAdminConfig(res.locals.config);
        items.forEach(u => { u.cpf_display = cpfDisplay(u); });

        res.render('pages/admin-usuarios', {
            ticketCount, adminConfig,
            title: 'Usuários', page: 'usuarios', admin: req.session.admin,
            items, total, pages, currentPage: pagina,
            busca, plano, status, planos,
        });
    } catch (err) {
        console.error('[admin/usuarios]', err);
        res.status(500).send('Erro ao carregar usuários.');
    }
});

// ── PERFIL DO USUÁRIO ─────────────────────────────────────────────────────────
router.get('/usuarios/:id', async (req, res) => {
    try {
        const [[user]] = await db.execute('SELECT * FROM user WHERE id = ?', [req.params.id]);
        if (!user) return res.redirect('/admin/usuarios');
        user.cpf_display = cpfDisplay(user);

        const [userCheckins]  = await db.execute(
            'SELECT c.*, g.nome AS academiaNome FROM checkin c LEFT JOIN gym g ON g.id=c.gym_id WHERE c.user_id=? ORDER BY c.data DESC LIMIT 20',
            [user.id]
        );
        const [userTickets]   = await db.execute('SELECT * FROM support_ticket WHERE user_id=? ORDER BY created_at DESC', [user.id]);
        const [userTransacoes]= await db.execute(
            'SELECT py.*, p.nome AS planoNome FROM payment py LEFT JOIN plan p ON p.id=py.plan_id WHERE py.user_id=? ORDER BY py.created_at DESC',
            [user.id]
        );
        const [academias]     = await db.execute('SELECT id, nome FROM gym WHERE status="ativa"');

        const [tc]  = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);

        res.render('pages/admin-usuario-perfil', {
            ticketCount: tc[0].cnt, adminConfig,
            title: `Perfil — ${user.nome}`, page: 'usuarios', admin: req.session.admin,
            user, userCheckins, userTickets, userTransacoes, academias,
        });
    } catch (err) {
        console.error('[admin/usuarios/:id]', err);
        res.status(500).send('Erro ao carregar perfil.');
    }
});

// ── ACADEMIAS ─────────────────────────────────────────────────────────────────
router.get('/academias/check-cnpj', adminAuth, async (req, res) => {
    const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14) return res.json({ exists: false });
    try {
        const [[{ cnt }]] = await db.execute(
            "SELECT COUNT(*) AS cnt FROM gym WHERE REPLACE(REPLACE(REPLACE(REPLACE(cnpj,'.','-'),'/',''),'-',''),' ','') = ?",
            [cnpj]
        );
        res.json({ exists: cnt > 0 });
    } catch { res.json({ exists: false }); }
});

router.get('/academias', adminAuth, async (req, res) => {
    try {
        const [academias] = await db.execute(`
            SELECT g.id, g.nome, g.cnpj, g.cidade, g.estado, g.status,
                   (SELECT COUNT(*) FROM user u WHERE u.gym_id = g.id) AS totalAlunos,
                   (SELECT nome FROM gym_admin ga WHERE ga.gym_id = g.id AND ga.role='owner' LIMIT 1) AS responsavel,
                   (SELECT plano FROM gym_contract gc WHERE gc.gym_id = g.id AND gc.ativo=1 LIMIT 1) AS plano
            FROM gym g ORDER BY g.status ASC, g.nome ASC
        `);
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-academias', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Academias', page: 'academias', admin: req.session.admin,
            academias, sucesso: req.query.ok || null, erro: req.query.err || null,
        });
    } catch (err) {
        console.error('[admin/academias]', err);
        res.status(500).send('Erro ao listar academias.');
    }
});

router.get('/academias/nova', adminAuth, async (req, res) => {
    const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
    const adminConfig = buildAdminConfig(res.locals.config);
    res.render('pages/admin-academia-nova', {
        ticketCount: tc[0].cnt, adminConfig,
        title: 'Nova Academia', page: 'academias', admin: req.session.admin, erro: null,
    });
});

router.post('/academias/nova', adminAuth, [
    body('nome').trim().notEmpty().withMessage('Nome da academia é obrigatório').isLength({ max: 120 }),
    body('cnpj').trim().notEmpty().withMessage('CNPJ é obrigatório'),
    body('gestor_nome').trim().notEmpty().withMessage('Nome do gestor é obrigatório'),
    body('gestor_email').isEmail().normalizeEmail().withMessage('E-mail do gestor inválido'),
    body('valor_mensal').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Valor mensal inválido'),
    body('max_alunos').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Máximo de alunos inválido'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        return res.render('pages/admin-academia-nova', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Nova Academia', page: 'academias', admin: req.session.admin,
            erro: errors.array()[0].msg,
        });
    }
    const {
        nome, cnpj, endereco, numero, bairro, cidade, estado, cep, telefone,
        plano, valor_mensal, max_alunos, contato_responsavel, data_inicio,
        gestor_nome, gestor_email,
    } = req.body;
    try {
        const cnpjClean = cnpj.replace(/\D/g, '');
        const cepClean  = cep  ? cep.replace(/\D/g, '')  : null;
        const telClean  = telefone ? telefone.replace(/\D/g, '') : null;

        const [gymRes] = await db.execute(
            `INSERT INTO gym (nome, cnpj, endereco, numero, bairro, cidade, estado, cep, telefone, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativa')`,
            [nome.trim(), cnpjClean, endereco||null, numero||null, bairro||null,
             cidade||null, estado||null, cepClean, telClean]
        );
        const gymId = gymRes.insertId;

        await db.execute(
            `INSERT INTO gym_contract (gym_id, plano, valor_mensal, max_alunos, ativo, data_inicio, contato_responsavel)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [gymId, plano||'basic', parseFloat(valor_mensal)||0,
             parseInt(max_alunos)||100, data_inicio||new Date().toISOString().slice(0,10),
             contato_responsavel||null]
        );

        const senhaTemporaria = gerarSenha();
        const hash = await bcrypt.hash(senhaTemporaria, 10);
        await db.execute(
            `INSERT INTO gym_admin (gym_id, nome, email, senha_hash, role) VALUES (?, ?, ?, ?, 'owner')`,
            [gymId, gestor_nome.trim(), gestor_email.trim().toLowerCase(), hash]
        );

        try {
            await sendBoasVindas({
                gestor: { nome: gestor_nome.trim(), email: gestor_email.trim() },
                gym: { nome: nome.trim() },
                senhaTemporaria,
            });
        } catch (emailErr) {
            console.error('[admin/academias/nova] email error:', emailErr.message);
        }

        res.redirect('/admin/academias?ok=' + encodeURIComponent(`Academia "${nome.trim()}" criada. Email enviado para ${gestor_email.trim()}.`));
    } catch (err) {
        console.error('[admin/academias/nova]', err);
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-academia-nova', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Nova Academia', page: 'academias', admin: req.session.admin,
            erro: err.code === 'ER_DUP_ENTRY' ? 'E-mail do gestor já existe no sistema.' : 'Erro ao criar academia.',
        });
    }
});

router.get('/academias/:id', adminAuth, async (req, res) => {
    const gymId = parseInt(req.params.id);
    try {
        const gym = await Gym.findById(gymId);
        if (!gym) return res.status(404).send('Academia não encontrada.');

        const [contrato]  = await db.execute('SELECT * FROM gym_contract WHERE gym_id = ? ORDER BY ativo DESC, created_at DESC LIMIT 1', [gymId]);
        const [gestores]  = await db.execute('SELECT id, nome, email, role, ativo, ultimo_login FROM gym_admin WHERE gym_id = ?', [gymId]);
        const [alunos]    = await db.execute('SELECT id, nome, email, status FROM user WHERE gym_id = ? ORDER BY nome ASC LIMIT 50', [gymId]);
        const [[{ totalAlunos }]] = await db.execute('SELECT COUNT(*) AS totalAlunos FROM user WHERE gym_id = ?', [gymId]);
        const [[{ checkinsTotal }]] = await db.execute('SELECT COUNT(*) AS checkinsTotal FROM checkin WHERE gym_id = ?', [gymId]);

        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-academia-detalhe', {
            ticketCount: tc[0].cnt, adminConfig,
            title: gym.nome, page: 'academias', admin: req.session.admin,
            gym, contrato: contrato[0]||null, gestores, alunos, totalAlunos, checkinsTotal,
            sucesso: req.query.ok||null, erro: req.query.err||null,
        });
    } catch (err) {
        console.error('[admin/academias/:id]', err);
        res.status(500).send('Erro ao carregar academia.');
    }
});

router.post('/academias/:id/aprovar', adminAuth, async (req, res) => {
    const gymId = parseInt(req.params.id);
    try {
        const gym = await Gym.findById(gymId);
        if (!gym) return res.redirect('/admin/academias?err=Academia+não+encontrada');

        await db.execute("UPDATE gym SET status='ativa' WHERE id=?", [gymId]);
        await db.execute('UPDATE gym_admin SET ativo=1 WHERE gym_id=?', [gymId]);

        // Gera nova senha temporária e envia para cada gestor pendente
        const [gestores] = await db.execute('SELECT nome, email FROM gym_admin WHERE gym_id=? AND role="owner" LIMIT 1', [gymId]);
        if (gestores[0]) {
            const senhaTemporaria = gerarSenha();
            const hash = await bcrypt.hash(senhaTemporaria, 10);
            await db.execute('UPDATE gym_admin SET senha_hash=? WHERE gym_id=? AND role="owner"', [hash, gymId]);
            try {
                await sendBoasVindas({ gestor: gestores[0], gym, senhaTemporaria });
            } catch (e) { console.error('[admin/academias/aprovar] email:', e.message); }
        }

        res.redirect(`/admin/academias/${gymId}?ok=Academia+aprovada+com+sucesso`);
    } catch (err) {
        console.error('[admin/academias/aprovar]', err);
        res.redirect(`/admin/academias/${gymId}?err=Erro+ao+aprovar`);
    }
});

router.post('/academias/:id/gestor', adminAuth, async (req, res) => {
    const gymId = parseInt(req.params.id);
    const { gestor_nome, gestor_email, gestor_role } = req.body;
    if (!gestor_nome?.trim() || !gestor_email?.trim()) {
        return res.redirect(`/admin/academias/${gymId}?err=Nome+e+email+são+obrigatórios`);
    }
    try {
        const senhaTemporaria = gerarSenha();
        const hash = await bcrypt.hash(senhaTemporaria, 10);
        await db.execute(
            `INSERT INTO gym_admin (gym_id, nome, email, senha_hash, role) VALUES (?, ?, ?, ?, ?)`,
            [gymId, gestor_nome.trim(), gestor_email.trim().toLowerCase(), hash, gestor_role||'manager']
        );
        const gym = await Gym.findById(gymId);
        try {
            await sendBoasVindas({ gestor: { nome: gestor_nome.trim(), email: gestor_email.trim() }, gym, senhaTemporaria });
        } catch (e) { console.error('[admin/academias/gestor] email:', e.message); }
        res.redirect(`/admin/academias/${gymId}?ok=Gestor+adicionado`);
    } catch (err) {
        console.error('[admin/academias/gestor]', err);
        const msg = err.code === 'ER_DUP_ENTRY' ? 'Email+já+cadastrado' : 'Erro+ao+adicionar+gestor';
        res.redirect(`/admin/academias/${gymId}?err=${msg}`);
    }
});

// ── PLANOS ───────────────────────────────────────────────────────────────────
router.get('/planos', async (req, res) => {
    try {
        const [planos, ticketCount] = await Promise.all([
            Plan.findAllWithSubscriberCount(),
            SupportTicket.countOpen(),
        ]);
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-planos', {
            ticketCount, adminConfig,
            title: 'Planos', page: 'planos', admin: req.session.admin,
            planos,
        });
    } catch (err) {
        console.error('[admin/planos]', err);
        res.status(500).send('Erro ao carregar planos.');
    }
});

// ── CHECK-INS ────────────────────────────────────────────────────────────────
router.get('/checkins', async (req, res) => {
    const perPage = 20;
    const pagina  = Math.floor(Number(req.query.page)) || 1;
    const offset  = (pagina - 1) * perPage;
    try {
        const [[{ total }]]        = await db.execute('SELECT COUNT(*) AS total FROM checkin c');
        const [[{ checkinsHoje }]] = await db.execute("SELECT COUNT(*) AS checkinsHoje FROM checkin WHERE DATE(data) = CURDATE()");

        const [items] = await db.execute(
            `SELECT c.*,
                    u.nome AS userName,
                    DATE_FORMAT(c.data, '%d/%m/%Y') AS dataStr,
                    DATE_FORMAT(c.data, '%H:%i')    AS hora
             FROM checkin c
             LEFT JOIN user u ON u.id = c.user_id
             ORDER BY c.data DESC LIMIT ${perPage} OFFSET ${offset}`
        );

        const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const [heatmapRaw] = await db.execute(
            'SELECT (DAYOFWEEK(data)-1) AS dia, COUNT(*) AS total FROM checkin GROUP BY DAYOFWEEK(data)'
        );
        const heatmap = diasSemana.map((_, d) => {
            const r = heatmapRaw.find(x => x.dia === d);
            return r ? Number(r.total) : 0;
        });

        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);

        res.render('pages/admin-checkins', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Check-ins', page: 'checkins', admin: req.session.admin,
            items, total: Number(total), pages: Math.ceil(total / perPage), currentPage: pagina,
            checkinsHoje: Number(checkinsHoje),
            heatmap: JSON.stringify(heatmap),
            diasSemana: JSON.stringify(diasSemana),
        });
    } catch (err) {
        console.error('[admin/checkins]', err);
        res.status(500).send('Erro ao carregar check-ins.');
    }
});

// ── FINANCEIRO ───────────────────────────────────────────────────────────────
router.get('/financeiro', async (req, res) => {
    try {
        const [[{ receitaMes }]]      = await db.execute("SELECT COALESCE(SUM(valor_final),0) AS receitaMes FROM payment WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) AND status='pago'");
        const [[{ receitaAnterior }]] = await db.execute("SELECT COALESCE(SUM(valor_final),0) AS receitaAnterior FROM payment WHERE MONTH(created_at)=MONTH(NOW()-INTERVAL 1 MONTH) AND YEAR(created_at)=YEAR(NOW()-INTERVAL 1 MONTH) AND status='pago'");
        const [[{ inadimplentes }]]   = await db.execute("SELECT COUNT(*) AS inadimplentes FROM payment WHERE status='pendente'");

        const [receitaPlanoRaw] = await db.execute(
            `SELECT p.nome, COALESCE(SUM(py.valor_final),0) AS valor, COUNT(up.id) AS count
             FROM plan p
             LEFT JOIN payment py ON py.plan_id=p.id AND py.status='pago'
             LEFT JOIN user_plan up ON up.plan_id=p.id AND up.status='ativo'
             GROUP BY p.id ORDER BY p.preco ASC`
        );

        const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const [receitaMensalRaw] = await db.execute(
            "SELECT MONTH(created_at)-1 AS mes, COALESCE(SUM(valor_final),0) AS total FROM payment WHERE status='pago' AND YEAR(created_at)=YEAR(NOW()) GROUP BY MONTH(created_at)"
        );
        const receitaMensal = meses.map((_, m) => {
            const r = receitaMensalRaw.find(x => x.mes === m);
            return r ? Number(r.total).toFixed(2) : '0.00';
        });

        const rm = Number(receitaMes), ra = Number(receitaAnterior);
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);

        res.render('pages/admin-financeiro', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Financeiro', page: 'financeiro', admin: req.session.admin,
            receitaMes: rm.toFixed(2),
            receitaAnterior: ra.toFixed(2),
            variacao: ra > 0 ? (((rm - ra) / ra) * 100).toFixed(1) : 0,
            receitaPorPlano: receitaPlanoRaw,
            inadimplentes: Number(inadimplentes),
            meses: JSON.stringify(meses),
            receitaMensal: JSON.stringify(receitaMensal),
        });
    } catch (err) {
        console.error('[admin/financeiro]', err);
        res.status(500).send('Erro ao carregar financeiro.');
    }
});

router.get('/financeiro/receitas', async (req, res) => {
    const { status = '', page = 1 } = req.query;
    const perPage = 20;
    const offset  = (parseInt(page) - 1) * perPage;
    try {
        const params = [];
        let where = 'WHERE 1=1';
        if (status) { where += ' AND py.status = ?'; params.push(status); }

        const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM payment py ${where}`, params);
        const [items] = await db.execute(
            `SELECT py.*, u.nome AS userName, u.email AS userEmail, p.nome AS planoNome
             FROM payment py
             LEFT JOIN user u ON u.id=py.user_id
             LEFT JOIN plan p ON p.id=py.plan_id
             ${where} ORDER BY py.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
            params
        );

        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-financeiro-receitas', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Receitas', page: 'financeiro', admin: req.session.admin,
            items, total: Number(total), pages: Math.ceil(total / perPage), currentPage: parseInt(page), status,
        });
    } catch (err) {
        console.error('[admin/financeiro/receitas]', err);
        res.status(500).send('Erro ao carregar receitas.');
    }
});

router.get('/financeiro/inadimplentes', async (req, res) => {
    try {
        const [lista] = await db.execute('SELECT * FROM vw_inadimplentes');
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-financeiro-inadimplentes', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Inadimplentes', page: 'financeiro', admin: req.session.admin,
            lista,
        });
    } catch (err) {
        console.error('[admin/financeiro/inadimplentes]', err);
        res.status(500).send('Erro ao carregar inadimplentes.');
    }
});

// ── SUPORTE ───────────────────────────────────────────────────────────────────
router.get('/suporte', async (req, res) => {
    const { status = '' } = req.query;
    try {
        const [lista, counts] = await Promise.all([
            SupportTicket.findAll({ status: status || null }),
            SupportTicket.counts(),
        ]);
        const adminConfig = buildAdminConfig(res.locals.config);

        res.render('pages/admin-suporte', {
            ticketCount: counts.aberto + counts.em_atendimento, adminConfig,
            title: 'Suporte', page: 'suporte', admin: req.session.admin,
            lista, status, counts,
        });
    } catch (err) {
        console.error('[admin/suporte]', err);
        res.status(500).send('Erro ao carregar suporte.');
    }
});

router.get('/suporte/:ticketId', async (req, res) => {
    try {
        const [[ticket]] = await db.execute('SELECT * FROM support_ticket WHERE id = ?', [req.params.ticketId]);
        if (!ticket) return res.redirect('/admin/suporte');

        const [msgs] = await db.execute(
            'SELECT * FROM support_message WHERE ticket_id = ? ORDER BY created_at ASC',
            [ticket.id]
        );
        const [[user]] = await db.execute('SELECT id, nome, email, cpf FROM user WHERE id = ?', [ticket.user_id]);

        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-suporte-chat', {
            ticketCount: tc[0].cnt, adminConfig,
            title: `Ticket #${ticket.id}`, page: 'suporte', admin: req.session.admin,
            ticket, msgs, user,
        });
    } catch (err) {
        console.error('[admin/suporte/:ticketId]', err);
        res.status(500).send('Erro ao carregar ticket.');
    }
});

// ── NOTIFICAÇÕES ─────────────────────────────────────────────────────────────
router.get('/notificacoes', async (req, res) => {
    try {
        const [lista, planos, ticketCount] = await Promise.all([
            Notification.findAll(),
            Plan.findAll({ activeOnly: true }),
            SupportTicket.countOpen(),
        ]);
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-notificacoes', {
            ticketCount, adminConfig,
            title: 'Notificações', page: 'notificacoes', admin: req.session.admin,
            lista, planos,
        });
    } catch (err) {
        console.error('[admin/notificacoes]', err);
        res.status(500).send('Erro ao carregar notificações.');
    }
});

// ── RELATÓRIOS ────────────────────────────────────────────────────────────────
router.get('/relatorios', async (req, res) => {
    try {
        // Crescimento: novos usuários por mês (6 meses)
        const [crescRaw] = await db.execute(
            `SELECT DATE_FORMAT(created_at, '%b') AS mes,
                    MONTH(created_at) AS mesNum,
                    YEAR(created_at)  AS ano,
                    COUNT(*) AS total
             FROM user
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
             GROUP BY YEAR(created_at), MONTH(created_at)
             ORDER BY ano ASC, mesNum ASC`
        );

        // Preenche meses sem cadastro com 0
        const mesesLabels = [], crescimento = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(); d.setMonth(d.getMonth() - i);
            const label = d.toLocaleString('pt-BR', { month: 'short' });
            mesesLabels.push(label);
            const r = crescRaw.find(x => x.mesNum === d.getMonth()+1 && x.ano === d.getFullYear());
            crescimento.push(r ? Number(r.total) : 0);
        }

        const [distPlanoRaw] = await db.execute(
            `SELECT p.nome, COUNT(up.id) AS count
             FROM plan p
             LEFT JOIN user_plan up ON up.plan_id=p.id AND up.status='ativo'
             GROUP BY p.id ORDER BY p.preco ASC`
        );

        const [acadAtivasRaw] = await db.execute(
            `SELECT g.nome, COUNT(c.id) AS count
             FROM gym g
             LEFT JOIN checkin c ON c.gym_id=g.id
             GROUP BY g.id ORDER BY count DESC LIMIT 6`
        );

        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);

        res.render('pages/admin-relatorios', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Relatórios', page: 'relatorios', admin: req.session.admin,
            meses: JSON.stringify(mesesLabels),
            crescimento: JSON.stringify(crescimento),
            distPlano: JSON.stringify(distPlanoRaw),
            acadAtivas: JSON.stringify(acadAtivasRaw),
        });
    } catch (err) {
        console.error('[admin/relatorios]', err);
        res.status(500).send('Erro ao carregar relatórios.');
    }
});

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────
router.get('/configuracoes', async (req, res) => {
    try {
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-configuracoes', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Configurações', page: 'configuracoes', admin: req.session.admin,
        });
    } catch (err) {
        console.error('[admin/configuracoes]', err);
        res.status(500).send('Erro ao carregar configurações.');
    }
});

// F6 — Gerenciamento de equipamentos
router.get('/equipamentos', async (req, res) => {
    try {
        const [tc] = await db.execute("SELECT COUNT(*) AS cnt FROM support_ticket WHERE status != 'resolvido'");
        const adminConfig = buildAdminConfig(res.locals.config);
        res.render('pages/admin-equipamentos', {
            ticketCount: tc[0].cnt, adminConfig,
            title: 'Equipamentos', page: 'equipamentos', admin: req.session.admin,
        });
    } catch (err) {
        console.error('[admin/equipamentos]', err);
        res.status(500).send('Erro ao carregar equipamentos.');
    }
});

module.exports = router;
