'use strict';

const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db               = require('../config/db');
const requireGymAdmin  = require('../middleware/requireGymAdmin');
const resolveTenant    = require('../middleware/resolveTenant');
const { limiterLogin } = require('../middleware/rateLimits');

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

module.exports = router;
