'use strict';

const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const crypto           = require('crypto');
const Fuse              = require('fuse.js');
const QRCode             = require('qrcode');
const { body, validationResult } = require('express-validator');
const db               = require('../config/db');
const requireGymAdmin  = require('../middleware/requireGymAdmin');
const resolveTenant    = require('../middleware/resolveTenant');
const { limiterLogin } = require('../middleware/rateLimits');
const User              = require('../models/User');
const { enviarRecuperacaoSenha } = require('../services/emailAuth');

// Cache de exercícios pra sugestão de vínculo (mesmo padrão de cache 24h + Fuse
// threshold 0.4 já usado em ai.js/router.js pra exercise_query)
let _exerciseSugestaoCache   = null;
let _exerciseSugestaoCacheAt = 0;
const EXERCISE_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;

async function getExerciseSugestaoCache() {
    if (_exerciseSugestaoCache && Date.now() - _exerciseSugestaoCacheAt < EXERCISE_CACHE_TTL_MS) {
        return _exerciseSugestaoCache;
    }
    const [rows] = await db.execute(
        'SELECT id, name, name_pt, target_muscle, body_part FROM exercises ORDER BY name ASC'
    );
    _exerciseSugestaoCache   = rows;
    _exerciseSugestaoCacheAt = Date.now();
    return _exerciseSugestaoCache;
}

async function sugerirExercicios(termo, limit = 8) {
    const query = (termo || '').trim();
    if (!query) return [];
    const cache = await getExerciseSugestaoCache();
    const fuse  = new Fuse(cache, { keys: ['name_pt', 'name'], threshold: 0.4 });
    return fuse.search(query, { limit }).map(r => r.item);
}

// Deriva o grupo_muscular (ENUM já existente em `equipamento`) a partir do
// body_part (inglês, ExerciseDB) do exercício vinculado
function mapBodyPartToGrupoMuscular(bodyPart) {
    const map = {
        chest: 'peito', back: 'costas', shoulders: 'ombro',
        'upper arms': 'braco', 'lower arms': 'braco',
        'upper legs': 'perna', 'lower legs': 'perna',
        waist: 'core', cardio: 'cardio',
    };
    return map[(bodyPart || '').toLowerCase()] || 'outro';
}

// Função simples pra validar CPF (mesma lógica usada no cadastro público)
function validarCPF(cpf) {
    cpf = String(cpf || '').replace(/\D/g, '');
    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
    let resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== parseInt(cpf[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
    resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== parseInt(cpf[10])) return false;
    return true;
}

// ── Migrations (IIFE) ─────────────────────────────────────────────────────────
(async () => {
    // 1. gym_admin
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS gym_admin (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gym_id        INT UNSIGNED NOT NULL,
                nome          VARCHAR(120) NOT NULL,
                email         VARCHAR(120) NOT NULL UNIQUE,
                senha_hash    VARCHAR(255) NOT NULL,
                role          ENUM('owner','manager') NOT NULL DEFAULT 'manager',
                ativo         TINYINT(1) NOT NULL DEFAULT 1,
                ultimo_login  DATETIME NULL,
                created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_gym_admin_gym (gym_id),
                INDEX idx_gym_admin_email (email),
                CONSTRAINT fk_gym_admin_gym FOREIGN KEY (gym_id) REFERENCES gym(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[gym-admin migration] gym_admin:', err.message); }

    // 2. gym_contract
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS gym_contract (
                id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gym_id              INT UNSIGNED NOT NULL,
                plano               ENUM('basic','pro','enterprise') NOT NULL DEFAULT 'basic',
                valor_mensal        DECIMAL(10,2) NOT NULL,
                max_alunos          INT UNSIGNED NOT NULL DEFAULT 100,
                ativo               TINYINT(1) NOT NULL DEFAULT 1,
                data_inicio         DATE NOT NULL,
                data_fim            DATE NULL,
                contato_responsavel VARCHAR(120) NULL,
                created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_gym_contract_gym (gym_id),
                CONSTRAINT fk_gym_contract_gym FOREIGN KEY (gym_id) REFERENCES gym(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[gym-admin migration] gym_contract:', err.message); }

    // 3. gym_plan_access
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS gym_plan_access (
                gym_id  INT UNSIGNED NOT NULL,
                plan_id INT UNSIGNED NOT NULL,
                PRIMARY KEY (gym_id, plan_id),
                CONSTRAINT fk_gpa_gym  FOREIGN KEY (gym_id)  REFERENCES gym(id)  ON DELETE CASCADE,
                CONSTRAINT fk_gpa_plan FOREIGN KEY (plan_id) REFERENCES plan(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[gym-admin migration] gym_plan_access:', err.message); }

    // 4. notification.gym_id
    for (const sql of [
        'ALTER TABLE notification ADD COLUMN gym_id INT UNSIGNED NULL AFTER destinatarios',
        'ALTER TABLE notification ADD INDEX idx_notification_gym (gym_id)',
        `ALTER TABLE notification ADD CONSTRAINT fk_notification_gym
            FOREIGN KEY (gym_id) REFERENCES gym(id) ON DELETE SET NULL`,
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060 && err.errno !== 1061 && err.errno !== 1826) console.error('[gym-admin migration] notification:', err.message); }
    }

    // 5. support_ticket.gym_id
    for (const sql of [
        'ALTER TABLE support_ticket ADD COLUMN gym_id INT UNSIGNED NULL AFTER admin_id',
        'ALTER TABLE support_ticket ADD INDEX idx_support_ticket_gym (gym_id)',
        `ALTER TABLE support_ticket ADD CONSTRAINT fk_support_ticket_gym
            FOREIGN KEY (gym_id) REFERENCES gym(id) ON DELETE SET NULL`,
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060 && err.errno !== 1061 && err.errno !== 1826) console.error('[gym-admin migration] support_ticket:', err.message); }
    }

    // 6. gym_plano
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS gym_plano (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gym_id        INT UNSIGNED NOT NULL,
                nome          VARCHAR(120) NOT NULL,
                duracao_dias  SMALLINT UNSIGNED NOT NULL,
                preco         DECIMAL(10,2) NOT NULL,
                ativo         TINYINT(1) NOT NULL DEFAULT 1,
                criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_gym_plano_gym (gym_id),
                CONSTRAINT fk_gym_plano_gym FOREIGN KEY (gym_id) REFERENCES gym(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[gym-admin migration] gym_plano:', err.message); }

    // 7. gym_matricula
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS gym_matricula (
                id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gym_id           INT UNSIGNED NOT NULL,
                aluno_id         INT UNSIGNED NOT NULL,
                plano_id         INT UNSIGNED NOT NULL,
                status           ENUM('ativa','vencida','cancelada') NOT NULL DEFAULT 'ativa',
                data_inicio      DATE NOT NULL,
                data_vencimento  DATE NOT NULL,
                criado_em        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_gym_matricula_gym (gym_id),
                INDEX idx_gym_matricula_aluno (aluno_id),
                CONSTRAINT fk_gym_matricula_gym   FOREIGN KEY (gym_id)   REFERENCES gym(id)       ON DELETE CASCADE,
                CONSTRAINT fk_gym_matricula_aluno FOREIGN KEY (aluno_id) REFERENCES user(id)      ON DELETE CASCADE,
                CONSTRAINT fk_gym_matricula_plano FOREIGN KEY (plano_id) REFERENCES gym_plano(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[gym-admin migration] gym_matricula:', err.message); }
})();

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
    if (req.session.gymAdmin) return res.redirect('/gym-admin/dashboard');
    res.render('gym-admin/login', { erro: null, next: req.query.next || '/gym-admin/dashboard' });
});

router.post('/login', limiterLogin, [
    body('email').isEmail().normalizeEmail().withMessage('E-mail inválido'),
    body('password').isLength({ min: 6 }).withMessage('Senha muito curta'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('gym-admin/login', {
            erro: errors.array()[0].msg,
            next: req.body.next || '/gym-admin/dashboard',
        });
    }
    const { email, password } = req.body;
    try {
        const [rows] = await db.execute(
            `SELECT ga.*, g.nome AS gym_nome
             FROM gym_admin ga JOIN gym g ON g.id = ga.gym_id
             WHERE ga.email = ? AND ga.ativo = 1`,
            [email]
        );
        const admin = rows[0];
        if (!admin || !(await bcrypt.compare(password, admin.senha_hash))) {
            return res.render('gym-admin/login', {
                erro: 'E-mail ou senha incorretos.',
                next: req.body.next || '/gym-admin/dashboard',
            });
        }
        req.session.gymAdmin = {
            id:       admin.id,
            gym_id:   admin.gym_id,
            nome:     admin.nome,
            role:     admin.role,
            gym_nome: admin.gym_nome,
        };
        await db.execute('UPDATE gym_admin SET ultimo_login = NOW() WHERE id = ?', [admin.id]);
        const next = req.body.next || '/gym-admin/dashboard';
        req.session.save(err => {
            if (err) return res.redirect('/gym-admin/login?erro=1');
            return res.redirect(next);
        });
    } catch (err) {
        console.error('[gym-admin/login]', err);
        res.render('gym-admin/login', { erro: 'Erro interno. Tente novamente.', next: '/gym-admin/dashboard' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/gym-admin/login'));
});

// ── Proteção + resolução de tenant em todas as rotas abaixo ──────────────────
router.use(requireGymAdmin, resolveTenant);

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
    const gymId = req.gymId;
    try {
        const [[{ totalAlunos }]]    = await db.execute('SELECT COUNT(*) AS totalAlunos FROM user WHERE gym_id = ? AND status = "ativo"', [gymId]);
        const [[{ checkinsHoje }]]   = await db.execute('SELECT COUNT(*) AS checkinsHoje FROM checkin WHERE gym_id = ? AND data = CURDATE()', [gymId]);
        const [[{ checkinsSemana }]] = await db.execute('SELECT COUNT(*) AS checkinsSemana FROM checkin WHERE gym_id = ? AND data >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)', [gymId]);
        const [[{ checkinsMes }]]    = await db.execute('SELECT COUNT(*) AS checkinsMes FROM checkin WHERE gym_id = ? AND MONTH(data) = MONTH(CURDATE()) AND YEAR(data) = YEAR(CURDATE())', [gymId]);
        const [[{ emRisco }]]        = await db.execute(`
            SELECT COUNT(*) AS emRisco FROM user u
            WHERE u.gym_id = ? AND u.status = 'ativo'
              AND NOT EXISTS (SELECT 1 FROM checkin c WHERE c.user_id = u.id AND c.data >= DATE_SUB(CURDATE(), INTERVAL 14 DAY))
        `, [gymId]);

        const [ultimosCheckins] = await db.execute(`
            SELECT c.data, c.hora, u.nome
            FROM checkin c JOIN user u ON u.id = c.user_id
            WHERE c.gym_id = ? ORDER BY c.data DESC, c.hora DESC LIMIT 5
        `, [gymId]);

        const [contrato] = await db.execute('SELECT * FROM gym_contract WHERE gym_id = ? AND ativo = 1 LIMIT 1', [gymId]);

        res.render('gym-admin/dashboard', {
            page: 'dashboard', gymAdmin: req.session.gymAdmin,
            totalAlunos, checkinsHoje, checkinsSemana, checkinsMes, emRisco,
            ultimosCheckins, contrato: contrato[0] || null,
        });
    } catch (err) {
        console.error('[gym-admin/dashboard]', err);
        res.status(500).send('Erro ao carregar dashboard.');
    }
});

// ── ALUNOS — LISTA ────────────────────────────────────────────────────────────
router.get('/alunos', async (req, res) => {
    const gymId  = req.gymId;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 20;
    const offset = (page - 1) * limit;
    const busca  = req.query.busca ? `%${req.query.busca}%` : null;

    try {
        const whereExtra = busca ? 'AND (u.nome LIKE ? OR u.email LIKE ?)' : '';
        const params     = busca ? [gymId, busca, busca] : [gymId];

        const [alunos] = await db.execute(`
            SELECT u.id, u.nome, u.email, u.status, u.created_at,
                   MAX(c.data) AS ultimo_checkin
            FROM user u
            LEFT JOIN checkin c ON c.user_id = u.id AND c.gym_id = u.gym_id
            WHERE u.gym_id = ? ${whereExtra}
            GROUP BY u.id ORDER BY u.nome ASC
            LIMIT ${limit} OFFSET ${offset}
        `, params);

        const countParams = busca ? [gymId, busca, busca] : [gymId];
        const [[{ total }]] = await db.execute(
            `SELECT COUNT(*) AS total FROM user u WHERE u.gym_id = ? ${whereExtra}`,
            countParams
        );

        res.render('gym-admin/alunos', {
            page: 'alunos', gymAdmin: req.session.gymAdmin,
            alunos, busca: req.query.busca || '',
            paginaAtual: page, totalPaginas: Math.ceil(total / limit), total,
        });
    } catch (err) {
        console.error('[gym-admin/alunos]', err);
        res.status(500).send('Erro ao listar alunos.');
    }
});

// ── ALUNOS — DETALHE ──────────────────────────────────────────────────────────
router.get('/alunos/:id', async (req, res) => {
    const gymId  = req.gymId;
    const userId = parseInt(req.params.id);

    try {
        // Garante que o aluno pertence à academia (segurança)
        const [rows] = await db.execute(
            'SELECT id, nome, email, status, created_at FROM user WHERE id = ? AND gym_id = ?',
            [userId, gymId]
        );
        const aluno = rows[0];
        if (!aluno) return res.status(404).send('Aluno não encontrado.');

        const [checkins] = await db.execute(
            'SELECT data, hora FROM checkin WHERE user_id = ? AND gym_id = ? ORDER BY data DESC LIMIT 20',
            [userId, gymId]
        );
        const [[{ totalCheckins }]] = await db.execute(
            'SELECT COUNT(*) AS totalCheckins FROM checkin WHERE user_id = ? AND gym_id = ?',
            [userId, gymId]
        );
        const [[{ totalTreinos }]] = await db.execute(
            'SELECT COUNT(*) AS totalTreinos FROM workout_plans WHERE user_id = ?',
            [userId]
        );
        const [medicoes] = await db.execute(
            'SELECT peso, altura FROM measurement WHERE user_id = ? ORDER BY data DESC LIMIT 1',
            [userId]
        );

        res.render('gym-admin/aluno-detalhe', {
            page: 'alunos', gymAdmin: req.session.gymAdmin,
            aluno, checkins, totalCheckins, totalTreinos,
            medicao: medicoes[0] || null,
        });
    } catch (err) {
        console.error('[gym-admin/alunos/:id]', err);
        res.status(500).send('Erro ao carregar aluno.');
    }
});

// ── CHECK-INS ─────────────────────────────────────────────────────────────────
router.get('/checkins', async (req, res) => {
    const gymId  = req.gymId;
    const filtro = req.query.filtro || 'hoje';
    const intervalos = {
        hoje:   'AND c.data = CURDATE()',
        semana: 'AND c.data >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)',
        mes:    'AND MONTH(c.data) = MONTH(CURDATE()) AND YEAR(c.data) = YEAR(CURDATE())',
    };
    const where = intervalos[filtro] || intervalos.hoje;

    try {
        const [checkins] = await db.execute(`
            SELECT c.data, c.hora, c.user_id, u.nome, u.email
            FROM checkin c JOIN user u ON u.id = c.user_id
            WHERE c.gym_id = ? ${where}
            ORDER BY c.data DESC, c.hora DESC LIMIT 200
        `, [gymId]);

        const [frequencia] = await db.execute(`
            SELECT DATE(c.data) AS dia, COUNT(*) AS total
            FROM checkin c
            WHERE c.gym_id = ? AND c.data >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY dia ORDER BY dia ASC
        `, [gymId]);

        res.render('gym-admin/checkins', {
            page: 'checkins', gymAdmin: req.session.gymAdmin,
            checkins, frequencia, filtro,
        });
    } catch (err) {
        console.error('[gym-admin/checkins]', err);
        res.status(500).send('Erro ao listar check-ins.');
    }
});

// ── RELATÓRIOS ────────────────────────────────────────────────────────────────
router.get('/relatorios', async (req, res) => {
    const gymId = req.gymId;
    try {
        const [[{ totalAlunos }]]   = await db.execute('SELECT COUNT(*) AS totalAlunos FROM user WHERE gym_id = ? AND status = "ativo"', [gymId]);
        const [[{ inativos }]]      = await db.execute('SELECT COUNT(*) AS inativos FROM user WHERE gym_id = ? AND status = "inativo"', [gymId]);
        const [[{ mediaCheckins }]] = await db.execute(`
            SELECT ROUND(AVG(cnt),1) AS mediaCheckins FROM (
                SELECT COUNT(*) AS cnt FROM checkin c JOIN user u ON u.id = c.user_id
                WHERE u.gym_id = ? AND c.data >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                GROUP BY c.user_id
            ) t
        `, [gymId]);
        const [[{ semCheckin }]] = await db.execute(`
            SELECT COUNT(*) AS semCheckin FROM user u
            WHERE u.gym_id = ? AND u.status = 'ativo'
              AND NOT EXISTS (SELECT 1 FROM checkin c WHERE c.user_id = u.id)
        `, [gymId]);
        const [crescimento] = await db.execute(`
            SELECT DATE_FORMAT(created_at, '%Y-%m') AS mes, COUNT(*) AS novos
            FROM user WHERE gym_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
            GROUP BY mes ORDER BY mes ASC
        `, [gymId]);

        res.render('gym-admin/relatorios', {
            page: 'relatorios', gymAdmin: req.session.gymAdmin,
            totalAlunos, inativos, mediaCheckins: mediaCheckins || 0,
            semCheckin, crescimento,
        });
    } catch (err) {
        console.error('[gym-admin/relatorios]', err);
        res.status(500).send('Erro ao gerar relatórios.');
    }
});

// ── NOTIFICAÇÃO ───────────────────────────────────────────────────────────────
router.get('/notificacao', (req, res) => {
    res.render('gym-admin/notificacao', {
        page: 'notificacao', gymAdmin: req.session.gymAdmin,
        sucesso: req.query.ok === '1', erro: null,
    });
});

router.post('/notificacao', async (req, res) => {
    const gymId = req.gymId;
    const { titulo, mensagem } = req.body;
    if (!titulo?.trim() || !mensagem?.trim()) {
        return res.render('gym-admin/notificacao', {
            page: 'notificacao', gymAdmin: req.session.gymAdmin,
            sucesso: false, erro: 'Título e mensagem são obrigatórios.',
        });
    }
    try {
        await db.execute(
            `INSERT INTO notification (titulo, mensagem, tipo, destinatarios, gym_id) VALUES (?, ?, 'info', 'gym', ?)`,
            [titulo.trim(), mensagem.trim(), gymId]
        );
        res.redirect('/gym-admin/notificacao?ok=1');
    } catch (err) {
        console.error('[gym-admin/notificacao]', err);
        res.render('gym-admin/notificacao', {
            page: 'notificacao', gymAdmin: req.session.gymAdmin,
            sucesso: false, erro: 'Erro ao enviar notificação.',
        });
    }
});

// ── PLANOS ────────────────────────────────────────────────────────────────────
router.get('/planos', async (req, res) => {
    const gymId = req.gymId;
    try {
        const [planos] = await db.execute(
            'SELECT * FROM gym_plano WHERE gym_id = ? ORDER BY ativo DESC, nome ASC',
            [gymId]
        );
        res.render('gym-admin/planos', {
            page: 'planos', gymAdmin: req.session.gymAdmin, planos,
        });
    } catch (err) {
        console.error('[gym-admin/planos]', err);
        res.status(500).send('Erro ao listar planos.');
    }
});

router.get('/planos/novo', (req, res) => {
    res.render('gym-admin/plano-form', {
        page: 'planos', gymAdmin: req.session.gymAdmin,
        plano: null, erro: null,
    });
});

router.post('/planos', [
    body('nome').trim().notEmpty().withMessage('Nome obrigatório.').isLength({ max: 120 }).withMessage('Nome muito longo.'),
    body('duracao_dias').isInt({ min: 1, max: 3650 }).withMessage('Duração inválida.'),
    body('preco').isFloat({ min: 0 }).withMessage('Preço inválido.'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('gym-admin/plano-form', {
            page: 'planos', gymAdmin: req.session.gymAdmin,
            plano: req.body, erro: errors.array()[0].msg,
        });
    }
    const gymId = req.gymId;
    const { nome, duracao_dias, preco } = req.body;
    try {
        await db.execute(
            'INSERT INTO gym_plano (gym_id, nome, duracao_dias, preco) VALUES (?, ?, ?, ?)',
            [gymId, nome.trim(), parseInt(duracao_dias), parseFloat(preco)]
        );
        res.redirect('/gym-admin/planos');
    } catch (err) {
        console.error('[gym-admin/planos POST]', err);
        res.render('gym-admin/plano-form', {
            page: 'planos', gymAdmin: req.session.gymAdmin,
            plano: req.body, erro: 'Erro ao criar plano.',
        });
    }
});

router.get('/planos/:id/editar', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [rows] = await db.execute('SELECT * FROM gym_plano WHERE id = ? AND gym_id = ?', [id, gymId]);
        const plano = rows[0];
        if (!plano) return res.status(404).send('Plano não encontrado.');
        res.render('gym-admin/plano-form', {
            page: 'planos', gymAdmin: req.session.gymAdmin, plano, erro: null,
        });
    } catch (err) {
        console.error('[gym-admin/planos/:id/editar]', err);
        res.status(500).send('Erro ao carregar plano.');
    }
});

router.post('/planos/:id', [
    body('nome').trim().notEmpty().withMessage('Nome obrigatório.').isLength({ max: 120 }).withMessage('Nome muito longo.'),
    body('duracao_dias').isInt({ min: 1, max: 3650 }).withMessage('Duração inválida.'),
    body('preco').isFloat({ min: 0 }).withMessage('Preço inválido.'),
], async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('gym-admin/plano-form', {
            page: 'planos', gymAdmin: req.session.gymAdmin,
            plano: { ...req.body, id }, erro: errors.array()[0].msg,
        });
    }
    const { nome, duracao_dias, preco } = req.body;
    try {
        const [result] = await db.execute(
            'UPDATE gym_plano SET nome = ?, duracao_dias = ?, preco = ? WHERE id = ? AND gym_id = ?',
            [nome.trim(), parseInt(duracao_dias), parseFloat(preco), id, gymId]
        );
        if (result.affectedRows === 0) return res.status(404).send('Plano não encontrado.');
        res.redirect('/gym-admin/planos');
    } catch (err) {
        console.error('[gym-admin/planos/:id POST]', err);
        res.render('gym-admin/plano-form', {
            page: 'planos', gymAdmin: req.session.gymAdmin,
            plano: { ...req.body, id }, erro: 'Erro ao salvar plano.',
        });
    }
});

router.post('/planos/:id/toggle', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [rows] = await db.execute('SELECT ativo FROM gym_plano WHERE id = ? AND gym_id = ?', [id, gymId]);
        if (!rows[0]) return res.status(404).send('Plano não encontrado.');
        await db.execute('UPDATE gym_plano SET ativo = ? WHERE id = ? AND gym_id = ?', [rows[0].ativo ? 0 : 1, id, gymId]);
        res.redirect('/gym-admin/planos');
    } catch (err) {
        console.error('[gym-admin/planos/:id/toggle]', err);
        res.status(500).send('Erro ao atualizar plano.');
    }
});

// ── MATRÍCULAS ────────────────────────────────────────────────────────────────
router.get('/matriculas', async (req, res) => {
    const gymId  = req.gymId;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 20;
    const offset = (page - 1) * limit;
    const statusFiltro = ['ativa', 'vencida', 'cancelada'].includes(req.query.status) ? req.query.status : null;

    try {
        const whereExtra = statusFiltro ? 'AND m.status = ?' : '';
        const params      = statusFiltro ? [gymId, statusFiltro] : [gymId];

        const [matriculas] = await db.execute(`
            SELECT m.id, m.status, m.data_inicio, m.data_vencimento,
                   u.nome AS aluno_nome, u.email AS aluno_email,
                   p.nome AS plano_nome
            FROM gym_matricula m
            JOIN user u ON u.id = m.aluno_id
            JOIN gym_plano p ON p.id = m.plano_id
            WHERE m.gym_id = ? ${whereExtra}
            ORDER BY m.criado_em DESC
            LIMIT ${limit} OFFSET ${offset}
        `, params);

        const [[{ total }]] = await db.execute(
            `SELECT COUNT(*) AS total FROM gym_matricula m WHERE m.gym_id = ? ${whereExtra}`,
            params
        );

        res.render('gym-admin/matriculas', {
            page: 'matriculas', gymAdmin: req.session.gymAdmin,
            matriculas, statusFiltro,
            paginaAtual: page, totalPaginas: Math.ceil(total / limit), total,
        });
    } catch (err) {
        console.error('[gym-admin/matriculas]', err);
        res.status(500).send('Erro ao listar matrículas.');
    }
});

router.get('/matriculas/nova', async (req, res) => {
    const gymId = req.gymId;
    try {
        const [planos] = await db.execute(
            'SELECT id, nome, duracao_dias, preco FROM gym_plano WHERE gym_id = ? AND ativo = 1 ORDER BY nome ASC',
            [gymId]
        );
        const [alunos] = await db.execute(
            'SELECT id, nome, email FROM user WHERE gym_id = ? ORDER BY nome ASC',
            [gymId]
        );
        res.render('gym-admin/matricula-nova', {
            page: 'matriculas', gymAdmin: req.session.gymAdmin,
            planos, alunos, erro: null, form: {},
        });
    } catch (err) {
        console.error('[gym-admin/matriculas/nova]', err);
        res.status(500).send('Erro ao carregar formulário.');
    }
});

router.post('/matriculas', [
    body('plano_id').isInt().withMessage('Selecione um plano.'),
    body('data_inicio').isISO8601().withMessage('Data de início inválida.'),
    body('aluno_modo').isIn(['existente', 'novo']).withMessage('Modo de aluno inválido.'),
], async (req, res) => {
    const gymId = req.gymId;

    const rerender = async (erro) => {
        const [planos] = await db.execute('SELECT id, nome, duracao_dias, preco FROM gym_plano WHERE gym_id = ? AND ativo = 1 ORDER BY nome ASC', [gymId]);
        const [alunos] = await db.execute('SELECT id, nome, email FROM user WHERE gym_id = ? ORDER BY nome ASC', [gymId]);
        return res.render('gym-admin/matricula-nova', {
            page: 'matriculas', gymAdmin: req.session.gymAdmin,
            planos, alunos, erro, form: req.body,
        });
    };

    const errors = validationResult(req);
    if (!errors.isEmpty()) return rerender(errors.array()[0].msg);

    const { plano_id, data_inicio, aluno_modo } = req.body;

    try {
        // Plano precisa pertencer à academia do admin logado (isolamento por tenant)
        const [planoRows] = await db.execute(
            'SELECT id, duracao_dias FROM gym_plano WHERE id = ? AND gym_id = ? AND ativo = 1',
            [parseInt(plano_id), gymId]
        );
        const plano = planoRows[0];
        if (!plano) return rerender('Plano inválido.');

        let alunoId;

        if (aluno_modo === 'existente') {
            const alunoIdInput = parseInt(req.body.aluno_id);
            if (!alunoIdInput) return rerender('Selecione um aluno.');
            // Aluno precisa pertencer à mesma academia (isolamento por tenant)
            const [alunoRows] = await db.execute(
                'SELECT id FROM user WHERE id = ? AND gym_id = ?',
                [alunoIdInput, gymId]
            );
            if (!alunoRows[0]) return rerender('Aluno inválido.');
            alunoId = alunoRows[0].id;
        } else {
            const nome   = (req.body.nome || '').trim();
            const email  = (req.body.email || '').trim().toLowerCase();
            const cpfRaw = (req.body.cpf || '');

            if (nome.length < 3) return rerender('Nome muito curto.');
            if (!validarCPF(cpfRaw)) return rerender('CPF inválido.');
            if (!/^\S+@\S+\.\S+$/.test(email)) return rerender('E-mail inválido.');

            const cpf = cpfRaw.replace(/\D/g, '');
            if (await User.findByCpf(cpf))     return rerender('CPF já cadastrado no sistema.');
            if (await User.findByEmail(email)) return rerender('E-mail já cadastrado no sistema.');

            // Senha aleatória e descartada — o aluno define a própria senha pelo link de convite
            const senhaAleatoria = crypto.randomBytes(24).toString('hex');
            const senha_hash     = await bcrypt.hash(senhaAleatoria, 10);
            const novoId = await User.create({ nome, cpf, email, senha_hash });
            await db.execute('UPDATE user SET gym_id = ? WHERE id = ?', [gymId, novoId]);
            alunoId = novoId;

            try {
                const token     = crypto.randomBytes(32).toString('hex');
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                await db.execute(
                    'INSERT INTO password_reset (user_id, token_hash, expira_em, ip_solicitacao) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR), ?)',
                    [alunoId, tokenHash, req.ip]
                );
                const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
                const link    = `${baseUrl}/redefinir-senha?token=${token}`;
                await enviarRecuperacaoSenha({ to: email, nome, link });
            } catch (mailErr) {
                console.error('[gym-admin/matriculas] falha ao enviar convite de senha:', mailErr.message);
            }
        }

        await db.execute(
            `INSERT INTO gym_matricula (gym_id, aluno_id, plano_id, status, data_inicio, data_vencimento)
             VALUES (?, ?, ?, 'ativa', ?, DATE_ADD(?, INTERVAL ? DAY))`,
            [gymId, alunoId, plano.id, data_inicio, data_inicio, plano.duracao_dias]
        );

        res.redirect('/gym-admin/matriculas');
    } catch (err) {
        console.error('[gym-admin/matriculas POST]', err);
        await rerender('Erro ao criar matrícula.');
    }
});

router.get('/matriculas/:id/editar', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [rows] = await db.execute(`
            SELECT m.*, u.nome AS aluno_nome, p.nome AS plano_nome
            FROM gym_matricula m
            JOIN user u ON u.id = m.aluno_id
            JOIN gym_plano p ON p.id = m.plano_id
            WHERE m.id = ? AND m.gym_id = ?
        `, [id, gymId]);
        const matricula = rows[0];
        if (!matricula) return res.status(404).send('Matrícula não encontrada.');
        res.render('gym-admin/matricula-editar', {
            page: 'matriculas', gymAdmin: req.session.gymAdmin, matricula, erro: null,
        });
    } catch (err) {
        console.error('[gym-admin/matriculas/:id/editar]', err);
        res.status(500).send('Erro ao carregar matrícula.');
    }
});

router.post('/matriculas/:id', [
    body('status').isIn(['ativa', 'vencida', 'cancelada']).withMessage('Status inválido.'),
], async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).send(errors.array()[0].msg);
    }
    try {
        const [result] = await db.execute(
            'UPDATE gym_matricula SET status = ? WHERE id = ? AND gym_id = ?',
            [req.body.status, id, gymId]
        );
        if (result.affectedRows === 0) return res.status(404).send('Matrícula não encontrada.');
        res.redirect('/gym-admin/matriculas');
    } catch (err) {
        console.error('[gym-admin/matriculas/:id POST]', err);
        res.status(500).send('Erro ao atualizar matrícula.');
    }
});

// ── EQUIPAMENTOS ──────────────────────────────────────────────────────────────
router.get('/equipamentos', async (req, res) => {
    const gymId = req.gymId;
    try {
        const [equipamentos] = await db.execute(`
            SELECT e.id, e.nome, e.grupo_muscular, e.ativo, e.created_at,
                   (SELECT COUNT(*) FROM equipamento_scan es WHERE es.equipamento_id = e.id) AS total_scans,
                   (SELECT ex.name_pt FROM equipamento_exercicio ee
                        JOIN exercises ex ON ex.id = ee.exercise_id
                        WHERE ee.equipamento_id = e.id LIMIT 1) AS exercicio_nome_pt,
                   (SELECT ex.name FROM equipamento_exercicio ee
                        JOIN exercises ex ON ex.id = ee.exercise_id
                        WHERE ee.equipamento_id = e.id LIMIT 1) AS exercicio_nome
            FROM equipamento e
            WHERE e.academia_id = ?
            ORDER BY e.nome ASC
        `, [gymId]);
        res.render('gym-admin/equipamentos', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin, equipamentos,
        });
    } catch (err) {
        console.error('[gym-admin/equipamentos]', err);
        res.status(500).send('Erro ao listar equipamentos.');
    }
});

router.get('/equipamentos/novo', (req, res) => {
    res.render('gym-admin/equipamento-form', {
        page: 'equipamentos', gymAdmin: req.session.gymAdmin,
        equipamento: null, exercicioSelecionado: null, erro: null,
    });
});

// Sugestões via Fuse.js pra vínculo com o exercício canônico — a academia
// confirma ou digita outro termo pra ajustar, nunca fica sem vínculo
router.get('/equipamentos/sugestoes', async (req, res) => {
    try {
        const sugestoes = await sugerirExercicios(req.query.nome, 8);
        res.json(sugestoes);
    } catch (err) {
        console.error('[gym-admin/equipamentos/sugestoes]', err);
        res.status(500).json([]);
    }
});

router.post('/equipamentos', [
    body('nome').trim().notEmpty().withMessage('Nome obrigatório.').isLength({ max: 100 }).withMessage('Nome muito longo.'),
    body('exercise_id').trim().notEmpty().withMessage('Selecione o exercício vinculado.'),
], async (req, res) => {
    const gymId = req.gymId;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('gym-admin/equipamento-form', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin,
            equipamento: req.body, exercicioSelecionado: null, erro: errors.array()[0].msg,
        });
    }
    const { nome, exercise_id } = req.body;
    try {
        const [[exercicio]] = await db.execute(
            'SELECT id, name, name_pt, body_part FROM exercises WHERE id = ?',
            [exercise_id]
        );
        if (!exercicio) {
            return res.render('gym-admin/equipamento-form', {
                page: 'equipamentos', gymAdmin: req.session.gymAdmin,
                equipamento: req.body, exercicioSelecionado: null, erro: 'Exercício inválido.',
            });
        }
        const grupo_muscular = mapBodyPartToGrupoMuscular(exercicio.body_part);
        const qr_token = crypto.randomUUID();
        const [result] = await db.execute(
            'INSERT INTO equipamento (nome, grupo_muscular, academia_id, qr_token) VALUES (?, ?, ?, ?)',
            [nome.trim(), grupo_muscular, gymId, qr_token]
        );
        await db.execute(
            'INSERT INTO equipamento_exercicio (equipamento_id, exercise_id) VALUES (?, ?)',
            [result.insertId, exercicio.id]
        );
        res.redirect('/gym-admin/equipamentos');
    } catch (err) {
        console.error('[gym-admin/equipamentos POST]', err);
        res.render('gym-admin/equipamento-form', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin,
            equipamento: req.body, exercicioSelecionado: null, erro: 'Erro ao criar equipamento.',
        });
    }
});

router.get('/equipamentos/:id/editar', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [[equipamento]] = await db.execute(
            'SELECT * FROM equipamento WHERE id = ? AND academia_id = ?',
            [id, gymId]
        );
        if (!equipamento) return res.status(404).send('Equipamento não encontrado.');

        const [[exercicioSelecionado]] = await db.execute(`
            SELECT ex.id, ex.name, ex.name_pt FROM equipamento_exercicio ee
            JOIN exercises ex ON ex.id = ee.exercise_id
            WHERE ee.equipamento_id = ? LIMIT 1
        `, [id]);

        res.render('gym-admin/equipamento-form', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin,
            equipamento, exercicioSelecionado: exercicioSelecionado || null, erro: null,
        });
    } catch (err) {
        console.error('[gym-admin/equipamentos/:id/editar]', err);
        res.status(500).send('Erro ao carregar equipamento.');
    }
});

router.post('/equipamentos/:id', [
    body('nome').trim().notEmpty().withMessage('Nome obrigatório.').isLength({ max: 100 }).withMessage('Nome muito longo.'),
    body('exercise_id').trim().notEmpty().withMessage('Selecione o exercício vinculado.'),
], async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('gym-admin/equipamento-form', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin,
            equipamento: { ...req.body, id }, exercicioSelecionado: null, erro: errors.array()[0].msg,
        });
    }
    const { nome, exercise_id } = req.body;
    try {
        // Isolamento por tenant: só pode editar equipamento da própria academia
        const [[dono]] = await db.execute(
            'SELECT id FROM equipamento WHERE id = ? AND academia_id = ?',
            [id, gymId]
        );
        if (!dono) return res.status(404).send('Equipamento não encontrado.');

        const [[exercicio]] = await db.execute(
            'SELECT id, body_part FROM exercises WHERE id = ?',
            [exercise_id]
        );
        if (!exercicio) {
            return res.render('gym-admin/equipamento-form', {
                page: 'equipamentos', gymAdmin: req.session.gymAdmin,
                equipamento: { ...req.body, id }, exercicioSelecionado: null, erro: 'Exercício inválido.',
            });
        }
        const grupo_muscular = mapBodyPartToGrupoMuscular(exercicio.body_part);

        await db.execute(
            'UPDATE equipamento SET nome = ?, grupo_muscular = ? WHERE id = ? AND academia_id = ?',
            [nome.trim(), grupo_muscular, id, gymId]
        );
        await db.execute('DELETE FROM equipamento_exercicio WHERE equipamento_id = ?', [id]);
        await db.execute(
            'INSERT INTO equipamento_exercicio (equipamento_id, exercise_id) VALUES (?, ?)',
            [id, exercicio.id]
        );

        res.redirect('/gym-admin/equipamentos');
    } catch (err) {
        console.error('[gym-admin/equipamentos/:id POST]', err);
        res.render('gym-admin/equipamento-form', {
            page: 'equipamentos', gymAdmin: req.session.gymAdmin,
            equipamento: { ...req.body, id }, exercicioSelecionado: null, erro: 'Erro ao salvar equipamento.',
        });
    }
});

router.post('/equipamentos/:id/toggle', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [[eq]] = await db.execute(
            'SELECT ativo FROM equipamento WHERE id = ? AND academia_id = ?',
            [id, gymId]
        );
        if (!eq) return res.status(404).send('Equipamento não encontrado.');
        await db.execute(
            'UPDATE equipamento SET ativo = ? WHERE id = ? AND academia_id = ?',
            [eq.ativo ? 0 : 1, id, gymId]
        );
        res.redirect('/gym-admin/equipamentos');
    } catch (err) {
        console.error('[gym-admin/equipamentos/:id/toggle]', err);
        res.status(500).send('Erro ao atualizar equipamento.');
    }
});

// Isolamento: só gera/baixa QR de equipamento da própria academia
router.get('/equipamentos/:id/qr', async (req, res) => {
    const gymId = req.gymId;
    const id = parseInt(req.params.id);
    try {
        const [[eq]] = await db.execute(
            'SELECT qr_token, nome FROM equipamento WHERE id = ? AND academia_id = ?',
            [id, gymId]
        );
        if (!eq) return res.status(404).send('Equipamento não encontrado.');

        const url = `${process.env.WEBAUTHN_ORIGIN || 'https://fitcrew.net'}/equipamento/${eq.qr_token}`;
        const png = await QRCode.toBuffer(url, {
            width: 400, margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });
        res.set({
            'Content-Type': 'image/png',
            'Content-Disposition': `attachment; filename="qr-${eq.nome.replace(/\s+/g, '-')}.png"`,
        });
        res.send(png);
    } catch (err) {
        console.error('[gym-admin/equipamentos/:id/qr]', err);
        res.status(500).send('Erro ao gerar QR.');
    }
});

module.exports = router;
