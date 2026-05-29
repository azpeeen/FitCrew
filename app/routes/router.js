// router.js
const express    = require('express');
const router     = express.Router();
const path       = require('path');
const multer     = require('multer');
const QRCode     = require('qrcode');
const bcrypt     = require('bcrypt');
const Fuse       = require('fuse.js');
const { body, validationResult } = require('express-validator');
const { enviarBoleto }   = require('../services/email');
const { gerarBoletoPDF } = require('../services/pdf');
const conquistas  = require('../services/conquistas');
const { calcularMetas }   = require('../services/nutricao');
const { searchAlimento }  = require('../services/foodSearch');
const webauthn            = require('../services/webauthn');
const db          = require('../config/db');
const User        = require('../models/User');
const Plan        = require('../models/Plan');
const Payment     = require('../models/Payment');
const ImcProfile  = require('../models/ImcProfile');
const BodyPhoto   = require('../models/BodyPhoto');
const i18n        = require('../config/i18n');
const { broadcast, onlineUsers } = require('../events');
const cloudinary = require('../config/cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const requirePlanLevel = require('../middleware/requirePlanLevel');

function safeJson(str, fallback) {
    try { return JSON.parse(str || 'null') ?? fallback; }
    catch { return fallback; }
}

// Migrations sequenciais — uma conexão só, evita max_user_connections no Clever Cloud
(async () => {
    // 1. Colunas de tradução de exercícios
    for (const sql of [
        'ALTER TABLE exercises ADD COLUMN name_pt VARCHAR(255) DEFAULT NULL',
        'ALTER TABLE exercises ADD COLUMN name_es VARCHAR(255) DEFAULT NULL',
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060) console.error('[migration] alter exercises:', err.message); }
    }

    // 2. Colunas de perfil de usuário
    for (const sql of [
        'ALTER TABLE user ADD COLUMN instagram_username VARCHAR(60) DEFAULT NULL',
        'ALTER TABLE user ADD COLUMN username VARCHAR(30) DEFAULT NULL',
        'ALTER TABLE user ADD COLUMN bio VARCHAR(150) DEFAULT NULL',
        'ALTER TABLE user ADD COLUMN medalhas_destaque JSON DEFAULT NULL',
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060) console.error('[migration] alter user perfil:', err.message); }
    }
    try { await db.execute('CREATE UNIQUE INDEX idx_username ON user(username)'); }
    catch (err) { if (err.errno !== 1061) console.error('[migration] idx_username:', err.message); }

    // 3. Colunas de soft delete e WebAuthn (F16)
    for (const sql of [
        "ALTER TABLE user ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL",
        "ALTER TABLE user ADD COLUMN deletion_scheduled_at TIMESTAMP NULL DEFAULT NULL",
        "ALTER TABLE user ADD COLUMN webauthn_credential_id VARCHAR(500) NULL DEFAULT NULL",
        "ALTER TABLE user ADD COLUMN webauthn_public_key TEXT NULL DEFAULT NULL",
        "ALTER TABLE user ADD COLUMN webauthn_counter INT UNSIGNED NOT NULL DEFAULT 0",
        "ALTER TABLE user ADD COLUMN webauthn_enabled TINYINT(1) NOT NULL DEFAULT 0",
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060) console.error('[migration] alter user F16:', err.message); }
    }
    try {
        await db.execute(
            "ALTER TABLE user MODIFY COLUMN status ENUM('ativo','inativo','pendente_exclusao') NOT NULL DEFAULT 'ativo'"
        );
    } catch (err) { if (err.errno !== 1060) console.error('[migration] status enum:', err.message); }

    // 4. Tabela de check-ins manuais de treino
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS treino_checkins (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id    INT UNSIGNED NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_treino_checkin_user_data (user_id, created_at),
                CONSTRAINT fk_treino_checkin_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { console.error('[migration] treino_checkins:', err.message); }

    // 4b. Tabelas de planos IA (devem existir antes de treino_sessao que tem FK para workout_plans)
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS workout_plans (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id         INT UNSIGNED NOT NULL,
                nome            VARCHAR(255) NOT NULL,
                descricao       TEXT NULL,
                exercicios_json JSON NOT NULL,
                criado_por_ia   TINYINT(1) NOT NULL DEFAULT 0,
                created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_workout_plan_user_nome (user_id, nome),
                CONSTRAINT fk_workout_plans_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] workout_plans:', err.message); }
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS diet_plans (
                id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id           INT UNSIGNED NOT NULL,
                nome              VARCHAR(255) NOT NULL,
                objetivo_calorico INT UNSIGNED NULL,
                proteina_diaria_g INT UNSIGNED NULL,
                refeicoes_json    JSON NOT NULL,
                criado_por_ia     TINYINT(1) NOT NULL DEFAULT 0,
                created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_diet_plan_user_nome (user_id, nome),
                CONSTRAINT fk_diet_plans_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] diet_plans:', err.message); }

    // 5. Tabelas de sessão de execução de treino
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS treino_sessao (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id         INT UNSIGNED NOT NULL,
                workout_plan_id INT UNSIGNED NOT NULL,
                iniciado_em     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finalizado_em   TIMESTAMP NULL,
                status          ENUM('em_andamento','completo','abandonado') NOT NULL DEFAULT 'em_andamento',
                PRIMARY KEY (id),
                INDEX idx_ts_user_status (user_id, status),
                CONSTRAINT fk_ts_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_ts_plan FOREIGN KEY (workout_plan_id) REFERENCES workout_plans(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS treino_sessao_exercicio (
                id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
                sessao_id         INT UNSIGNED NOT NULL,
                exercise_query    VARCHAR(255) NOT NULL,
                series_realizadas TINYINT UNSIGNED NOT NULL DEFAULT 0,
                carga_usada       VARCHAR(50) NULL,
                concluido         TINYINT(1) NOT NULL DEFAULT 0,
                PRIMARY KEY (id),
                UNIQUE KEY uq_sessao_ex (sessao_id, exercise_query),
                CONSTRAINT fk_tse_sessao FOREIGN KEY (sessao_id) REFERENCES treino_sessao(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { console.error('[migration] treino_sessao:', err.message); }

    // 6. Tabelas de conquistas + seed do catálogo
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS conquistas (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                slug        VARCHAR(80) NOT NULL UNIQUE,
                nome        VARCHAR(100) NOT NULL,
                descricao   VARCHAR(255),
                categoria   ENUM('braco','perna','peito','costas','ombro','core','cardio','consistencia','ia') NOT NULL,
                tier        ENUM('bronze','prata','ouro','platina','diamante') NOT NULL,
                icone       VARCHAR(10),
                meta_valor  DECIMAL(8,2),
                meta_tipo   ENUM('peso','duracao','contagem','booleano') NOT NULL,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS usuario_conquistas (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                user_id       INT UNSIGNED NOT NULL,
                conquista_id  INT NOT NULL,
                desbloqueada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_conquista (user_id, conquista_id),
                CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_uc_conquista FOREIGN KEY (conquista_id) REFERENCES conquistas(id)
            ) ENGINE=InnoDB
        `);
        await db.execute(`
            INSERT IGNORE INTO conquistas (slug,nome,descricao,categoria,tier,icone,meta_valor,meta_tipo) VALUES
            ('braco-bronze','Braço de Macarrão','Registrou 20kg em exercício de braço','braco','bronze','💪',20,'peso'),
            ('braco-prata','Tá Aquecendo','Registrou 35kg em exercício de braço','braco','prata','💪',35,'peso'),
            ('braco-ouro','Lenda do Curl','Registrou 50kg em exercício de braço','braco','ouro','💪',50,'peso'),
            ('braco-platina','Braço de Ferro','Registrou 65kg em exercício de braço','braco','platina','💪',65,'peso'),
            ('braco-diamante','Não É Photoshop','Registrou 80kg em exercício de braço','braco','diamante','💪',80,'peso'),
            ('perna-bronze','Nunca Falta o Leg','Registrou 60kg em exercício de perna','perna','bronze','🦵',60,'peso'),
            ('perna-prata','Agacha Que Dói','Registrou 100kg em exercício de perna','perna','prata','🦵',100,'peso'),
            ('perna-ouro','Perna de Touro','Registrou 150kg em exercício de perna','perna','ouro','🦵',150,'peso'),
            ('perna-platina','Perna de Concreto','Registrou 200kg em exercício de perna','perna','platina','🦵',200,'peso'),
            ('perna-diamante','Humano? Duvido','Registrou 250kg em exercício de perna','perna','diamante','🦵',250,'peso'),
            ('peito-bronze','Começando a Forma','Registrou 40kg em exercício de peito','peito','bronze','🏋️',40,'peso'),
            ('peito-prata','Peito de Pombo','Registrou 60kg em exercício de peito','peito','prata','🏋️',60,'peso'),
            ('peito-ouro','Supino Sagrado','Registrou 80kg em exercício de peito','peito','ouro','🏋️',80,'peso'),
            ('peito-platina','Caixa Torácica de Aço','Registrou 100kg em exercício de peito','peito','platina','🏋️',100,'peso'),
            ('peito-diamante','Arnold Sorriu','Registrou 120kg em exercício de peito','peito','diamante','🏋️',120,'peso'),
            ('costas-bronze','Postura Corrigida','Registrou 40kg em exercício de costas','costas','bronze','🔙',40,'peso'),
            ('costas-prata','Remada Iniciada','Registrou 60kg em exercício de costas','costas','prata','🔙',60,'peso'),
            ('costas-ouro','Abrindo as Asas','Registrou 80kg em exercício de costas','costas','ouro','🔙',80,'peso'),
            ('costas-platina','Remada Sagrada','Registrou 110kg em exercício de costas','costas','platina','🔙',110,'peso'),
            ('costas-diamante','Largura Infinita','Registrou 140kg em exercício de costas','costas','diamante','🔙',140,'peso'),
            ('ombro-bronze','Ombro Aquecido','Registrou 15kg em exercício de ombro','ombro','bronze','🏔️',15,'peso'),
            ('ombro-prata','Deltoide Ativo','Registrou 25kg em exercício de ombro','ombro','prata','🏔️',25,'peso'),
            ('ombro-ouro','Três Cabeças Acordadas','Registrou 40kg em exercício de ombro','ombro','ouro','🏔️',40,'peso'),
            ('ombro-platina','Ombro de Titã','Registrou 55kg em exercício de ombro','ombro','platina','🏔️',55,'peso'),
            ('ombro-diamante','Atlas Humano','Registrou 70kg em exercício de ombro','ombro','diamante','🏔️',70,'peso'),
            ('core-bronze','Barriga Acordada','Registrou 10kg em exercício de core','core','bronze','🔥',10,'peso'),
            ('core-prata','Core Ativado','Registrou 20kg em exercício de core','core','prata','🔥',20,'peso'),
            ('core-ouro','Prancha de Aço','Registrou 30kg em exercício de core','core','ouro','🔥',30,'peso'),
            ('core-platina','Abdômen Blindado','Registrou 45kg em exercício de core','core','platina','🔥',45,'peso'),
            ('core-diamante','O Abdominal Não Mente','Registrou 60kg em exercício de core','core','diamante','🔥',60,'peso'),
            ('cardio-bronze','Saiu do Sofá','Completou 30min de cardio','cardio','bronze','🏃',30,'duracao'),
            ('cardio-prata','Corredor Nato','Completou 45min de cardio','cardio','prata','🏃',45,'duracao'),
            ('cardio-ouro','Pulmão de Ferro','Completou 60min de cardio','cardio','ouro','🏃',60,'duracao'),
            ('cardio-platina','Ultramaratonista','Completou 90min de cardio','cardio','platina','🏃',90,'duracao'),
            ('cardio-diamante','Não Para Nunca','Completou 120min de cardio','cardio','diamante','🏃',120,'duracao'),
            ('consist-bronze','Primeira Rep','Completou a primeira sessão de treino','consistencia','bronze','🏆',1,'contagem'),
            ('consist-prata','Em Chamas','3 dias consecutivos de treino','consistencia','prata','🏆',3,'contagem'),
            ('consist-ouro','Semana Completa','5 checkins na mesma semana','consistencia','ouro','🏆',5,'contagem'),
            ('consist-platina','Inabalável','7 dias consecutivos de treino','consistencia','platina','🏆',7,'contagem'),
            ('consist-diamante','Lenda do Gym','30 dias consecutivos de treino','consistencia','diamante','🏆',30,'contagem'),
            ('ia-treino','Primeiro Protocolo','Gerou o primeiro plano de treino com IA','ia','bronze','🤖',1,'booleano'),
            ('ia-dieta','Nutri Bro','Gerou o primeiro plano de dieta com IA','ia','bronze','🤖',1,'booleano'),
            ('ia-avaliacao','Corpo Analisado','Realizou a primeira avaliação corporal','ia','prata','🤖',1,'booleano')
        `);
    } catch (err) { console.error('[migration] conquistas:', err.message); }

    // 7. Tabela de registro nutricional diário
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS nutrition_log (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id       INT UNSIGNED NOT NULL,
                descricao     VARCHAR(255) NOT NULL,
                kcal          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
                proteina      DECIMAL(5,1) NOT NULL DEFAULT 0,
                carboidrato   DECIMAL(5,1) NOT NULL DEFAULT 0,
                gordura       DECIMAL(5,1) NOT NULL DEFAULT 0,
                foto_url      VARCHAR(500) DEFAULT NULL,
                refeicao      ENUM('cafe','lanche_manha','almoco','lanche_tarde','jantar','ceia','agua') NOT NULL DEFAULT 'almoco',
                registrado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_nl_user_data (user_id, registrado_em),
                CONSTRAINT fk_nl_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { console.error('[migration] nutrition_log:', err.message); }

    // 8. Colunas extras de nutrition_log
    for (const sql of [
        'ALTER TABLE nutrition_log ADD COLUMN proteina_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER kcal',
        'ALTER TABLE nutrition_log ADD COLUMN carbs_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER proteina_g',
        'ALTER TABLE nutrition_log ADD COLUMN gordura_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER carbs_g',
        'ALTER TABLE nutrition_log ADD COLUMN fibra_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER gordura_g',
        "ALTER TABLE nutrition_log ADD COLUMN refeicao_tipo ENUM('cafe','almoco','jantar','lanche','outro') NOT NULL DEFAULT 'outro' AFTER refeicao",
        'ALTER TABLE nutrition_log ADD COLUMN foto_url VARCHAR(500) DEFAULT NULL',
        'ALTER TABLE nutrition_log ADD COLUMN data DATE GENERATED ALWAYS AS (DATE(registrado_em)) STORED',
        'ALTER TABLE nutrition_log ADD INDEX idx_nl_user_data2 (user_id, data)',
    ]) {
        try { await db.execute(sql); }
        catch (err) { if (err.errno !== 1060 && err.errno !== 1061 && err.errno !== 1054) console.error('[migration] nutrition_log extra:', err.message); }
    }

    // 9. Coluna nutricao_objetivo (via INFORMATION_SCHEMA para idempotência)
    try {
        const [[col]] = await db.execute(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'user'
              AND COLUMN_NAME = 'nutricao_objetivo'
        `);
        if (!col) {
            await db.execute(
                "ALTER TABLE `user` ADD COLUMN nutricao_objetivo ENUM('cutting','manutencao','bulking') DEFAULT NULL"
            );
        }
    } catch (err) { console.error('[migration] nutricao_objetivo:', err.message); }

    // 10. Coluna horario em nutrition_log
    try { await db.execute('ALTER TABLE nutrition_log ADD COLUMN horario TIME DEFAULT NULL'); }
    catch (err) { if (err.errno !== 1060) console.error('[migration] nutrition_log horario:', err.message); }

    // 11. Tabela de itens individuais de refeição
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS nutrition_item (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
                log_id        INT UNSIGNED NOT NULL,
                alimento_nome VARCHAR(200) NOT NULL,
                quantidade_g  DECIMAL(8,1) NOT NULL,
                kcal          DECIMAL(8,1) NOT NULL DEFAULT 0,
                proteina_g    DECIMAL(8,1) NOT NULL DEFAULT 0,
                carbs_g       DECIMAL(8,1) NOT NULL DEFAULT 0,
                gordura_g     DECIMAL(8,1) NOT NULL DEFAULT 0,
                fibra_g       DECIMAL(8,1) NOT NULL DEFAULT 0,
                fonte         ENUM('usda','openfoodfacts','ia','manual') NOT NULL DEFAULT 'manual',
                fonte_id      VARCHAR(100) NULL,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                CONSTRAINT fk_ni_log FOREIGN KEY (log_id) REFERENCES nutrition_log(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] nutrition_item:', err.message); }

    // 12. Adiciona valor 'taco' ao ENUM fonte de nutrition_item
    try {
        await db.execute(
            "ALTER TABLE nutrition_item MODIFY COLUMN fonte ENUM('usda','openfoodfacts','ia','manual','taco') NOT NULL DEFAULT 'manual'"
        );
    } catch (err) { if (err.errno !== 1060) console.error('[migration] nutrition_item fonte:', err.message); }

    // 13. F6/F9 — Equipamentos, vínculos de exercício e scans de QR
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS equipamento (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
                nome           VARCHAR(100) NOT NULL,
                descricao      VARCHAR(255) NULL,
                grupo_muscular ENUM('peito','costas','ombro','braco','perna','core','cardio','outro') NOT NULL DEFAULT 'outro',
                academia_id    INT UNSIGNED NULL,
                qr_token       VARCHAR(36) NOT NULL UNIQUE,
                ativo          TINYINT(1) NOT NULL DEFAULT 1,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                CONSTRAINT fk_eq_academia FOREIGN KEY (academia_id) REFERENCES gym(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS equipamento_exercicio (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
                equipamento_id INT UNSIGNED NOT NULL,
                exercise_id    VARCHAR(50) NOT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_eq_ex (equipamento_id, exercise_id),
                CONSTRAINT fk_eqex_eq FOREIGN KEY (equipamento_id) REFERENCES equipamento(id) ON DELETE CASCADE,
                CONSTRAINT fk_eqex_ex FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS equipamento_scan (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
                equipamento_id INT UNSIGNED NOT NULL,
                user_id        INT UNSIGNED NULL,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_scan_eq (equipamento_id, created_at),
                CONSTRAINT fk_scan_eq   FOREIGN KEY (equipamento_id) REFERENCES equipamento(id) ON DELETE CASCADE,
                CONSTRAINT fk_scan_user FOREIGN KEY (user_id)        REFERENCES user(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] F6 equipamento tables:', err.message); }

    // 14. Fix: exercise_id em equipamento_exercicio deve ser VARCHAR(50) para referenciar exercises.id
    try {
        await db.execute('ALTER TABLE equipamento_exercicio DROP FOREIGN KEY fk_eqex_ex');
    } catch (err) {
        if (err.errno !== 1091) console.error('[F6 drop fk_eqex_ex]', err.message);
    }
    try {
        await db.execute(
            'ALTER TABLE equipamento_exercicio MODIFY COLUMN exercise_id VARCHAR(50) NOT NULL'
        );
    } catch (err) {
        if (err.errno !== 1060) console.error('[F6 alter equipamento_exercicio]', err.message);
    }
    try {
        await db.execute(
            'ALTER TABLE equipamento_exercicio ADD CONSTRAINT fk_eqex_ex FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE'
        );
    } catch (err) {
        if (err.errno !== 1826) console.error('[F6 add fk_eqex_ex]', err.message);
    }

    // 15. context_summary em ai_session
    try {
        await db.execute('ALTER TABLE ai_session ADD COLUMN context_summary TEXT NULL');
    } catch (err) {
        if (err.errno !== 1060) console.error('[migration] ai_session context_summary:', err.message);
    }

    // 16. push_subscriptions (Web Push VAPID)
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id           INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
                user_id      INT UNSIGNED    NOT NULL,
                endpoint     VARCHAR(512)    NOT NULL,
                p256dh       VARCHAR(255)    NOT NULL,
                auth         VARCHAR(255)    NOT NULL,
                device_label VARCHAR(100)    NULL,
                created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_endpoint (endpoint),
                CONSTRAINT fk_push_user FOREIGN KEY (user_id)
                    REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] push_subscriptions:', err.message); }

    // 17. Remover plano Starter e atualizar preços
    try {
        const [[starterRow]] = await db.execute("SELECT id FROM plan WHERE slug='starter' LIMIT 1");
        if (starterRow) {
            const [[gymbroRow]] = await db.execute("SELECT id FROM plan WHERE slug='gymbro' LIMIT 1");
            if (gymbroRow) {
                await db.execute("UPDATE user_plan SET plan_id=? WHERE plan_id=?", [gymbroRow.id, starterRow.id]);
                await db.execute("UPDATE payment   SET plan_id=? WHERE plan_id=?", [gymbroRow.id, starterRow.id]);
            }
            await db.execute("DELETE FROM plan WHERE slug='starter'");
        }
        await db.execute("UPDATE plan SET preco=29.90 WHERE slug='gymbro' AND preco=85.60");
        await db.execute("UPDATE plan SET preco=59.90 WHERE slug='black' AND preco=145.90");
    } catch (err) { console.error('[migration] planos_update:', err.message); }

    // 18. Atualizar benefícios do GymBro (remover referência ao Starter)
    try {
        const gymbroBen = JSON.stringify([
            'Treinos manuais + execução com GIFs',
            'IA treinadora personalizada',
            'Plano de treino gerado por IA',
            'Plano de dieta gerado por IA',
            'Histórico completo de conversas IA',
        ]);
        await db.execute(
            "UPDATE plan SET beneficios=? WHERE slug='gymbro' AND JSON_SEARCH(beneficios, 'one', 'Tudo do Starter') IS NOT NULL",
            [gymbroBen]
        );
    } catch (err) { console.error('[migration] gymbro_beneficios:', err.message); }

    // 19. Tabela de tickets de suporte
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS ticket (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id    INT UNSIGNED NOT NULL,
                assunto    VARCHAR(150) NOT NULL,
                mensagem   TEXT NOT NULL,
                tipo       VARCHAR(100) NOT NULL DEFAULT 'Outro',
                status     ENUM('aberto','em_atendimento','fechado') NOT NULL DEFAULT 'aberto',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_ticket_user (user_id),
                CONSTRAINT fk_ticket_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] ticket:', err.message); }

    try {
        await db.execute("ALTER TABLE ticket ADD COLUMN tipo VARCHAR(100) NOT NULL DEFAULT 'Outro' AFTER mensagem");
        await db.execute("ALTER TABLE ticket DROP COLUMN categoria");
    } catch (err) {
        if (err.errno !== 1060 && err.errno !== 1091) console.error('[migration] ticket alter:', err.message);
    }

    // 20. Tabela de mensagens de ticket
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS ticket_mensagem (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                ticket_id  INT UNSIGNED NOT NULL,
                remetente  ENUM('usuario','admin') NOT NULL DEFAULT 'usuario',
                texto      TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_tm_ticket (ticket_id),
                CONSTRAINT fk_tm_ticket FOREIGN KEY (ticket_id) REFERENCES ticket(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    } catch (err) { if (err.errno !== 1050) console.error('[migration] ticket_mensagem:', err.message); }
})();

// Soft delete cron — anonimiza contas com deletion_scheduled_at vencido (a cada 24h)
(async () => {
    async function executarSoftDelete() {
        try {
            const [contas] = await db.execute(
                "SELECT id FROM user WHERE status='pendente_exclusao' AND deletion_scheduled_at <= NOW()"
            );
            for (const conta of contas) {
                await db.execute(`
                    UPDATE user SET
                        nome               = 'Usuário Removido',
                        email              = CONCAT('deleted_', id, '@gymbros.removed'),
                        cpf                = CONCAT('deleted_', id),
                        senha_hash         = '',
                        profile_photo      = NULL,
                        bio                = NULL,
                        instagram_username = NULL,
                        username           = NULL,
                        deleted_at         = NOW(),
                        status             = 'inativo',
                        webauthn_enabled   = 0,
                        webauthn_credential_id = NULL,
                        webauthn_public_key    = NULL
                    WHERE id = ?
                `, [conta.id]);
                await db.execute('DELETE FROM nutrition_log WHERE user_id=?',  [conta.id]).catch(() => {});
                await db.execute('DELETE FROM imc_profile  WHERE user_id=?',  [conta.id]).catch(() => {});
                await db.execute('DELETE FROM body_photo   WHERE user_id=?',  [conta.id]).catch(() => {});
            }
            if (contas.length > 0) console.log(`[soft-delete] ${contas.length} conta(s) anonimizadas`);
        } catch (err) {
            console.error('[soft-delete cron]', err.message);
        }
    }
    setTimeout(() => {
        executarSoftDelete();
        setInterval(executarSoftDelete, 24 * 60 * 60 * 1000);
    }, 5000);
})();

// ── Multer: upload de foto de perfil ──────────────────────────────────────────
const photoStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder:            'gymbros/profile_photos',
        allowed_formats:   ['jpg', 'jpeg', 'png', 'webp'],
        transformation:    [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
        public_id:         (req) => `avatar_${req.session.user?.cpf?.replace(/\D/g, '') || Date.now()}`,
    },
});
const photoUpload = multer({
    storage: photoStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) {
            return cb(new Error('Formato inválido. Use JPEG, PNG ou WebP.'));
        }
        cb(null, true);
    },
});

// ── Multer: upload de foto de alimento (Groq Vision) ─────────────────────────
const fotoNutricaoStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder:          'gymbros/nutricao',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation:  [{ width: 800, height: 800, crop: 'limit', quality: 80 }],
        public_id:       (req) => `nutricao_${req.session.user?.id || 'anon'}_${Date.now()}`,
    },
});
const fotoNutricaoUpload = multer({
    storage: fotoNutricaoStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) {
            return cb(new Error('Formato inválido. Use JPEG, PNG ou WebP.'));
        }
        cb(null, true);
    },
});

// ── Middleware: rastreia usuários online ──────────────────────────────────────
router.use((req, res, next) => {
    if (req.session && req.session.user) {
        const user = req.session.user;
        const uid  = String(user.id);
        const isNew = !onlineUsers.has(uid);
        onlineUsers.set(uid, { nome: user.nome, email: user.email, page: req.path, lastSeen: Date.now() });
        if (isNew) {
            broadcast('user_online', { id: uid, nome: user.nome, email: user.email, page: req.path, lastSeen: Date.now() });
        } else {
            broadcast('user_activity', { id: uid, nome: user.nome, page: req.path, lastSeen: Date.now() });
        }
    }
    next();
});

// ── Middlewares de autenticação ───────────────────────────────────────────────

/**
 * Só exige login. Qualquer usuário autenticado passa.
 */
function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

/**
 * Exige login + plano ativo.
 * Pending (PIX/boleto aguardando confirmação) → redireciona com aviso.
 * Sem plano → redireciona para /planos com banner.
 */
function requirePlano(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    const user = req.session.user;

    if (!user.plano) {
        return res.redirect('/planos?semPlano=1');
    }
    next();
}

// Função simples pra validar CPF (só pra demo)
function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
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

// ====================
// ROTAS GET
// ====================

// Páginas públicas
router.get('/', (req, res) => res.render('pages/index', { seo: {
    title:         'FitCrew — Treino Inteligente com IA',
    description:   'Treine com inteligência artificial ao seu lado. Planos de treino, dieta e acompanhamento personalizados com o FitCrew. A partir de R$ 29,90/mês.',
    keywords:      'treino inteligente, personal trainer ia, gymbros, treinos online, saúde, bem-estar, ia fitness',
    canonical:     '/',
    ogTitle:       'FitCrew — Treino Inteligente com IA',
    ogDescription: 'Planos de treino e dieta personalizados por IA. Comece agora.',
}}));

router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/area-aluno');
    res.render('pages/login', { seo: {
        title:         'Login — FitCrew',
        description:   'Acesse sua conta FitCrew para ver seus treinos, acompanhar sua evolução e usar o personal trainer IA GymBot.',
        keywords:      'login gymbros, entrar gymbros, acesso aluno',
        canonical:     '/login',
        robots:        'noindex, follow',
        ogTitle:       'Entrar no FitCrew',
        ogDescription: 'Acesse sua conta e continue seu treino.',
    }});
});

router.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/area-aluno');
    res.render('pages/register', { user: req.session.user || null, seo: {
        title:         'Cadastro — FitCrew',
        description:   'Crie sua conta FitCrew gratuitamente e acesse treinos personalizados, planos de dieta e o personal trainer IA GymBot.',
        keywords:      'cadastro gymbros, criar conta, registrar gymbros',
        canonical:     '/register',
        ogTitle:       'Crie sua Conta FitCrew Grátis',
        ogDescription: 'Junte-se a milhares de alunos e treine sem limites.',
    }});
});

router.get('/planos', (req, res) => res.render('pages/planos', { seo: {
    title:         'Planos FitCrew: GymBro e Black',
    description:   'Compare os planos FitCrew: GymBro (R$29,90) e Black (R$59,90). Treino inteligente, IA personalizada e acompanhamento completo.',
    keywords:      'planos gymbros, treino com ia, assinatura fitness, plano treino ia',
    canonical:     '/planos',
    ogTitle:       'Escolha seu Plano FitCrew — A partir de R$29,90',
    ogDescription: 'GymBro ou Black. Treino inteligente + IA personal trainer.',
}}));

router.get('/academias', (req, res) => res.render('pages/academias', { seo: {
    title:         'Academias — FitCrew',
    description:   'Encontre academias e estúdios cadastrados no FitCrew perto de você.',
    keywords:      'academia, academia perto de mim, gymbros academias, mapa academia',
    canonical:     '/academias',
    ogTitle:       'Academias FitCrew — Mapa',
    ogDescription: 'Encontre academias cadastradas no FitCrew perto de você.',
}}));

router.get('/compra', (req, res) => res.render('pages/compra', { seo: {
    title:         'Assinar FitCrew — Dados de Pagamento',
    description:   'Finalize sua assinatura FitCrew com segurança. Acesse treinos personalizados por IA em minutos.',
    keywords:      'assinar gymbros, pagamento academia, contratar gymbros',
    canonical:     '/compra',
    robots:        'noindex, nofollow',
    ogTitle:       'Assinar FitCrew',
    ogDescription: 'Finalize sua assinatura e comece a treinar agora.',
}}));

router.get('/compra2', (req, res) => res.render('pages/compra2', { seo: {
    title:         'Assinar FitCrew — Confirmação de Plano',
    description:   'Revise e confirme os dados do seu plano FitCrew antes de finalizar a assinatura.',
    keywords:      'confirmar plano gymbros, assinatura',
    canonical:     '/compra2',
    robots:        'noindex, nofollow',
    ogTitle:       'Confirmação de Plano — FitCrew',
    ogDescription: 'Revise seu plano antes de finalizar.',
}}));

router.get('/compra3', (req, res) => res.render('pages/compra3', { seo: {
    title:         'Assinatura FitCrew Confirmada!',
    description:   'Sua assinatura FitCrew foi confirmada! Acesse agora treinos personalizados por IA e o GymBot personal trainer IA.',
    keywords:      'assinatura confirmada gymbros, bem vindo gymbros',
    canonical:     '/compra3',
    robots:        'noindex, nofollow',
    ogTitle:       'Bem-vindo ao FitCrew!',
    ogDescription: 'Assinatura confirmada. Comece a treinar agora mesmo!',
}}));


// Pagamento
router.get('/pagamento', async (req, res) => {
    if (!req.session.user) {
        const plano = req.query.plano ? `?plano=${encodeURIComponent(req.query.plano)}` : '';
        return res.redirect(`/login?redirect=/pagamento${encodeURIComponent(plano)}`);
    }
    const slug = (req.query.plano || 'gymbro').toLowerCase();
    try {
        const plano = await Plan.findBySlug(slug);
        if (!plano || plano.status !== 'ativo') return res.redirect('/planos');
        res.render('pages/pagamento', {
            user: req.session.user,
            plano,
            seo: {
                title:       'Pagamento — FitCrew',
                canonical:   '/pagamento',
                robots:      'noindex, nofollow',
                description: 'Finalize sua assinatura FitCrew com segurança.',
            }
        });
    } catch (err) {
        console.error('[pagamento]', err);
        res.redirect('/planos');
    }
});

router.post('/api/pagamento',
  [
    body('planoId').notEmpty().withMessage('Plano obrigatório.'),
    body('valor').isFloat({ min: 0.01 }).withMessage('Valor inválido.'),
    body('metodo').isIn(['cartao', 'pix', 'boleto']).withMessage('Método de pagamento inválido.'),
  ],
  async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { planoId, planoNome, valor, metodo, parcelas, cartaoFinal, bandeira } = req.body;
    const user   = req.session.user;
    const status = 'pago';
    const valorN = Number(valor);

    try {
        const plan = await Plan.findBySlugOrName(planoId, planoNome);
        if (!plan) return res.status(400).json({ erro: 'Plano não encontrado.' });

        const paymentId = await Payment.create({
            user_id:         user.id,
            plan_id:         plan.id,
            valor_bruto:     valorN,
            valor_final:     valorN,
            metodo,
            parcelas:        Number(parcelas) || 1,
            cartao_final:    cartaoFinal || null,
            cartao_bandeira: bandeira || null,
            status,
        });

        // 3. Ativar plano via procedure
        if (status === 'pago') {
            try {
                await db.execute('CALL sp_ativar_plano(?, ?, ?)', [user.id, plan.id, paymentId]);
            } catch (spErr) {
                console.error('[pagamento] sp_ativar_plano ERRO:', spErr.message);
            }
        }

        // 4. Atualizar sessão
        req.session.user = { ...user, plano: plan.nome, planoId: plan.id, planoSlug: plan.slug, status: 'ativo' };

        // 5. Notificar admin via SSE
        broadcast('nova_compra', {
            paymentId,
            userName:  user.nome,
            userEmail: user.email,
            planoNome: plan.nome,
            valor:     valorN,
            metodo,
            status,
        });

        req.session.save(err => {
            if (err) console.error('[pagamento] session save error:', err);
            return res.json({ ok: true, status, transacaoId: paymentId });
        });
    } catch (err) {
        console.error('[api/pagamento]', err);
        return res.status(500).json({ ok: false, erro: 'Erro ao processar pagamento.' });
    }
});

// ── GET /api/pix/qr — gera QR Code PIX ───────────────────────────────────────
router.get('/api/pix/qr', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { planoId, valor } = req.query;
    const valorNum = Number(valor) || 0;
    const valorStr = valorNum.toFixed(2);

    // EMV PIX payload simplificado (demo)
    function pixField(id, value) {
        const len = String(value.length).padStart(2, '0');
        return `${id}${len}${value}`;
    }
    const merchantInfo = pixField('00', 'br.gov.bcb.pix') +
                         pixField('01', 'gymbros@pix.com.br');
    const payload =
        pixField('00', '01') +
        pixField('26', merchantInfo) +
        pixField('52', '0000') +
        pixField('53', '986') +
        pixField('54', valorStr) +
        pixField('58', 'BR') +
        pixField('59', 'GYMBROS TCC') +
        pixField('60', 'Sao Paulo') +
        pixField('62', pixField('05', planoId || 'pl002'));

    // CRC16 simplificado (apenas para demo — não é CRC real)
    const crc = '0000';
    const fullPayload = payload + pixField('63', crc);

    try {
        const dataUrl = await QRCode.toDataURL(fullPayload, { width: 220, margin: 1 });
        const expiraEm = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos
        res.json({ ok: true, dataUrl, pixPayload: fullPayload, expiraEm });
    } catch (err) {
        console.error('[pix/qr]', err);
        res.status(500).json({ ok: false, erro: 'Erro ao gerar QR Code.' });
    }
});

// ── POST /api/boleto — gera boleto PDF e envia e-mail ─────────────────────────
router.post('/api/boleto', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { planoNome, valor } = req.body;
    const user = req.session.user;

    const linhaDigitavel = '23790.00009 01020.269702 03010.247409 8 94350000006490';
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 3);
    const vencimentoStr = vencimento.toLocaleDateString('pt-BR');

    try {
        const pdfBuffer = await gerarBoletoPDF({
            nome:          user.nome,
            email:         user.email,
            planoNome,
            valor:         Number(valor),
            linhaDigitavel,
            vencimento:    vencimentoStr,
        });

        await enviarBoleto({
            to:            user.email,
            nome:          user.nome,
            planoNome,
            valor:         Number(valor),
            linhaDigitavel,
            pdfBuffer,
        });

        res.json({ ok: true, linhaDigitavel, vencimento: vencimentoStr, emailEnviado: true });
    } catch (err) {
        console.error('[boleto]', err);
        res.status(500).json({ ok: false, erro: 'Erro ao gerar boleto.' });
    }
});

router.get('/about', (req, res) => res.render('pages/about', { seo: {
    title:         'Sobre o FitCrew — Nossa Missão e Equipe',
    description:   'Conheça a história do FitCrew, nossa missão de democratizar o acesso à saúde e fitness no Brasil e o time apaixonado por esporte.',
    keywords:      'sobre gymbros, história gymbros, missão gymbros, equipe gymbros',
    canonical:     '/about',
    ogTitle:       'Sobre o FitCrew — Saúde para Todos',
    ogDescription: 'Nossa missão: democratizar o acesso à saúde e ao fitness no Brasil.',
}}));

router.get('/privacidade', (req, res) => res.render('pages/privacidade', { user: req.session.user || null, seo: {
    title:         'Política de Privacidade — FitCrew',
    description:   'Saiba como o FitCrew coleta, usa e protege seus dados pessoais em conformidade com a LGPD.',
    keywords:      'política de privacidade gymbros, lgpd gymbros, proteção de dados gymbros',
    canonical:     '/privacidade',
    ogTitle:       'Política de Privacidade — FitCrew',
    ogDescription: 'Transparência total sobre como tratamos seus dados pessoais.',
}}));

router.get('/termos', (req, res) => res.render('pages/termos', { user: req.session.user || null, seo: {
    title:         'Termos de Serviço — FitCrew',
    description:   'Leia os termos e condições de uso da plataforma FitCrew: planos, pagamentos, cancelamento e uso aceitável.',
    keywords:      'termos de serviço gymbros, termos de uso gymbros, condições gymbros',
    canonical:     '/termos',
    ogTitle:       'Termos de Serviço — FitCrew',
    ogDescription: 'Conheça as regras e condições para uso da plataforma FitCrew.',
}}));

router.get('/faq', (req, res) => res.render('pages/faq', { user: req.session.user || null, seo: {
    title:         'FAQ — Perguntas Frequentes | FitCrew',
    description:   'Respostas para as dúvidas mais comuns sobre o FitCrew: acesso a academias, planos, pagamentos, IA e suporte.',
    keywords:      'faq gymbros, dúvidas gymbros, perguntas frequentes gymbros',
    canonical:     '/faq',
    ogTitle:       'Perguntas Frequentes — FitCrew',
    ogDescription: 'Tire suas dúvidas sobre o FitCrew: planos, academias, pagamentos e mais.',
}}));

// F6 — Scanner de QR Code
router.get('/scan', requireAuth, (req, res) => {
    res.render('pages/scan', {
        user: req.session.user,
        seo: { title: 'Escanear Equipamento — FitCrew', robots: 'noindex' },
    });
});

// F6 — Página do equipamento (requer login)
router.get('/equipamento/:qr_token', requireAuth, async (req, res) => {
    try {
        const [[equipamento]] = await db.execute(
            `SELECT e.*, g.nome AS academia_nome
             FROM equipamento e
             LEFT JOIN gym g ON g.id = e.academia_id
             WHERE e.qr_token = ? AND e.ativo = 1`,
            [req.params.qr_token]
        );
        if (!equipamento) return res.status(404).render('pages/404', { user: req.session.user });

        const [exercicios] = await db.execute(`
            SELECT ex.id, ex.name, ex.name_pt, ex.target_muscle, ex.body_part,
                   em.cloudinary_gif_url AS gif_url
            FROM equipamento_exercicio ee
            JOIN exercises ex ON ex.id = ee.exercise_id
            LEFT JOIN exercise_media em ON em.exercise_id = ex.id
            WHERE ee.equipamento_id = ?
            ORDER BY ex.name ASC
        `, [equipamento.id]);

        // F9 — registrar scan
        await db.execute(
            'INSERT INTO equipamento_scan (equipamento_id, user_id) VALUES (?, ?)',
            [equipamento.id, req.session.user.id]
        ).catch(() => {});

        res.render('pages/equipamento', {
            user: req.session.user,
            equipamento,
            exercicios,
            seo: {
                title:       `${equipamento.nome} — FitCrew`,
                robots:      'noindex',
                description: `Exercícios no ${equipamento.nome} com GIFs de execução.`,
            },
        });
    } catch (err) {
        console.error('[equipamento]', err.message);
        res.redirect('/area-aluno');
    }
});

// Área do Aluno (protegida — requer plano ativo)
router.get('/area-aluno', requirePlano, async (req, res) => {
    if (!req.session.user.imc) {
        return res.redirect('/imc-form?primeiro=1');
    }
    const uid = req.session.user.id;
    try {
        const [[extraRow], [[cqRow]], [[semanaRow]], ultimasConqRows] = await Promise.all([
            db.execute('SELECT last_imc_update, last_avaliacao_update, notification_interval_days FROM user WHERE id = ?', [uid]),
            db.execute('SELECT COUNT(*) as total FROM usuario_conquistas WHERE user_id = ?', [uid]),
            db.execute('SELECT COUNT(*) as semana FROM treino_checkins WHERE user_id = ? AND YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)', [uid]),
            db.execute(`SELECT c.nome, c.icone, c.tier FROM usuario_conquistas uc JOIN conquistas c ON c.id = uc.conquista_id WHERE uc.user_id = ? ORDER BY uc.desbloqueada_em DESC LIMIT 2`, [uid]),
        ]);
        const extra          = extraRow[0] || {};
        const totalConquistas   = cqRow?.total || 0;
        const checkinsNaSemana  = semanaRow?.semana || 0;
        const metaSemanal       = Math.min(Math.round((checkinsNaSemana / 5) * 100), 100);
        const ultimasConquistas = ultimasConqRows[0] || [];

        res.render('pages/area-aluno', {
            user: { ...req.session.user, ...extra },
            totalConquistas,
            checkinsNaSemana,
            metaSemanal,
            ultimasConquistas,
            seo: {
                title: 'Painel do Aluno — FitCrew', canonical: '/area-aluno',
                robots: 'noindex, nofollow', description: 'Painel do aluno FitCrew.',
            },
        });
    } catch (err) {
        console.error('[area-aluno]', err);
        res.render('pages/area-aluno', {
            user: req.session.user,
            totalConquistas: 0, checkinsNaSemana: 0, metaSemanal: 0, ultimasConquistas: [],
            seo: { title: 'Painel do Aluno — FitCrew', canonical: '/area-aluno', robots: 'noindex, nofollow', description: 'Painel do aluno FitCrew.' },
        });
    }
});

router.post('/config/notificacao-intervalo', requireAuth, async (req, res) => {
    const dias = Math.max(1, parseInt(req.body.dias) || 7);
    try {
        await db.execute('UPDATE user SET notification_interval_days = ? WHERE id = ?',
            [dias, req.session.user.id]);
        req.session.user.notification_interval_days = dias;
        res.json({ ok: true });
    } catch (err) {
        console.error('[notificacao-intervalo]', err);
        res.status(500).json({ ok: false });
    }
});

//Treinos
const SUGESTOES_TREINO = [
    { id: 1, nome: 'Treino de Peito',      duracao: 50, tipo: 'Força',       icone: 'fa-dumbbell',   exercicios: ['Supino reto', 'Crucifixo', 'Peck deck', 'Flexão'] },
    { id: 2, nome: 'Treino de Pernas',      duracao: 60, tipo: 'Força',       icone: 'fa-dumbbell',   exercicios: ['Agachamento', 'Leg press', 'Cadeira extensora', 'Panturrilha'] },
    { id: 3, nome: 'Yoga Relaxamento',      duracao: 40, tipo: 'Alongamento', icone: 'fa-leaf',       exercicios: ['Saudação ao sol', 'Postura da criança', 'Torção espinhal'] },
    { id: 4, nome: 'Treino de Costas',      duracao: 55, tipo: 'Força',       icone: 'fa-dumbbell',   exercicios: ['Remada curvada', 'Puxada frontal', 'Remada unilateral'] },
    { id: 5, nome: 'Treino de Ombros',      duracao: 45, tipo: 'Força',       icone: 'fa-dumbbell',   exercicios: ['Desenvolvimento', 'Elevação lateral', 'Elevação frontal'] },
    { id: 6, nome: 'Cardio Intenso',        duracao: 35, tipo: 'Cardio',      icone: 'fa-running',    exercicios: ['Esteira 20min', 'Bicicleta 15min'] },
    { id: 7, nome: 'Pilates',               duracao: 50, tipo: 'Alongamento', icone: 'fa-leaf',       exercicios: ['Controle respiratório', 'Fortalecimento core'] },
    { id: 8, nome: 'Treino Abdominal',      duracao: 30, tipo: 'Força',       icone: 'fa-dumbbell',   exercicios: ['Crunch', 'Prancha', 'Abdominal oblíquo'] },
    { id: 9, nome: 'HIIT',                  duracao: 25, tipo: 'Cardio',      icone: 'fa-fire',       exercicios: ['Burpee', 'Mountain climber', 'Jumping jack', 'Sprint'] }
];

let _gifCache   = null;
let _gifCacheAt = 0;
const GIF_TTL_MS = 24 * 60 * 60 * 1000;

async function getGifCache() {
    if (_gifCache && Date.now() - _gifCacheAt < GIF_TTL_MS) return _gifCache;
    const [rows] = await db.execute(
        `SELECT e.name, em.cloudinary_gif_url
         FROM exercises e
         JOIN exercise_media em ON em.exercise_id = e.id`
    );
    _gifCache   = rows.map(r => ({ name: r.name, gif_url: r.cloudinary_gif_url }));
    _gifCacheAt = Date.now();
    return _gifCache;
}

async function lookupGif(query, cache) {
    if (!query) return null;
    const q = query.toLowerCase().trim();
    const exact = cache.find(r => r.name.toLowerCase() === q);
    if (exact) return exact.gif_url;
    const fuse = new Fuse(cache, { keys: ['name'], threshold: 0.4 });
    const results = fuse.search(query);
    return results.length > 0 ? results[0].item.gif_url : null;
}

router.get('/treinos', requirePlano, async (req, res) => {
    let workouts = [];
    let iaPlanos = [];
    try {
        [workouts] = await db.execute(
            `SELECT w.*, GROUP_CONCAT(e.nome ORDER BY we.ordem SEPARATOR ', ') AS exercicios_nomes
             FROM workout w
             LEFT JOIN workout_exercise we ON we.workout_id = w.id
             LEFT JOIN exercise e ON e.id = we.exercise_id
             WHERE w.user_id = ? AND w.ativo = 1
             GROUP BY w.id
             ORDER BY w.created_at DESC`,
            [req.session.user.id]
        );
    } catch (err) {
        console.error('[treinos]', err);
    }
    try {
        const [planRows] = await db.execute(
            'SELECT * FROM workout_plans WHERE user_id = ? ORDER BY created_at ASC',
            [req.session.user.id]
        );
        iaPlanos = planRows.map(row => ({
            ...row,
            exercicios_json: typeof row.exercicios_json === 'string'
                ? JSON.parse(row.exercicios_json)
                : row.exercicios_json,
        }));
    } catch (err) {
        console.error('[treinos/iaPlanos]', err);
    }
    try {
        const gifCache = await getGifCache();
        for (const plano of iaPlanos) {
            for (const ex of plano.exercicios_json) {
                ex.gif_url = await lookupGif(ex.exercise_query, gifCache);
            }
        }
    } catch (err) {
        console.error('[treinos/gifs]', err);
    }
    res.render('pages/treinos', {
        user: req.session.user,
        workouts,
        iaPlanos,
        sugestoes: SUGESTOES_TREINO,
        seo: { title: 'Meus Treinos — FitCrew', canonical: '/treinos', robots: 'noindex, nofollow', description: 'Gerencie seus treinos no FitCrew.' },
    });
});

// DELETE /treinos/plano/:id — remove plano de treino da IA
router.delete('/treinos/plano/:id', requireAuth, async (req, res) => {
    const userId  = req.session.user.id;
    const planoId = parseInt(req.params.id, 10);
    if (!planoId) return res.status(400).json({ ok: false });
    try {
        const [result] = await db.execute(
            'DELETE FROM workout_plans WHERE id = ? AND user_id = ?',
            [planoId, userId]
        );
        if (!result.affectedRows) return res.status(404).json({ ok: false, error: 'Plano não encontrado.' });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[treinos/plano/delete]', err.message);
        return res.status(500).json({ ok: false, error: 'Erro ao deletar.' });
    }
});

// POST /treinos/checkin — registra presença manual (máx 1 por dia)
router.post('/treinos/checkin', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [existing] = await db.execute(
            `SELECT id FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1`,
            [userId]
        );
        if (existing.length > 0) {
            return res.status(409).json({ ok: false, erro: 'Você já registrou presença hoje.' });
        }
        const [result] = await db.execute(
            'INSERT INTO treino_checkins (user_id) VALUES (?)',
            [userId]
        );
        const [rows] = await db.execute(
            'SELECT created_at FROM treino_checkins WHERE id = ?',
            [result.insertId]
        );
        const novasConquistas = await conquistas.verificarConsistencia(userId).catch(() => []);
        return res.json({ ok: true, created_at: rows[0].created_at, novasConquistas });
    } catch (err) {
        console.error('[checkin]', err.message);
        return res.status(500).json({ ok: false, erro: 'Erro ao registrar check-in.' });
    }
});

// GET /treinos/checkin/status — retorna status do check-in do dia + streak
router.get('/treinos/checkin/status', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [todayRows] = await db.execute(
            `SELECT created_at FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1`,
            [userId]
        );
        const checkedInToday = todayRows.length > 0;
        const todayCheckin   = checkedInToday ? todayRows[0].created_at : null;

        const [lastRows] = await db.execute(
            `SELECT created_at FROM treino_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        const lastCheckin = lastRows.length > 0 ? lastRows[0].created_at : null;

        let diasSemCheckin = 0;
        if (lastCheckin) {
            diasSemCheckin = Math.floor((Date.now() - new Date(lastCheckin)) / 86400000);
        }

        // Streak: dias consecutivos com check-in
        const [dateRows] = await db.execute(
            `SELECT DATE(created_at) AS data
             FROM treino_checkins WHERE user_id = ?
             GROUP BY DATE(created_at) ORDER BY data DESC`,
            [userId]
        );
        let streak = 0;
        if (dateRows.length > 0) {
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
            const toDate   = s => (s instanceof Date ? s.toISOString().slice(0, 10) : String(s).slice(0, 10));
            const dateSet  = new Set(dateRows.map(r => toDate(r.data)));
            let cursor     = new Date(todayStr + 'T12:00:00Z');
            if (!checkedInToday) cursor = new Date(cursor.getTime() - 86400000);
            while (dateSet.has(cursor.toISOString().slice(0, 10))) {
                streak++;
                cursor = new Date(cursor.getTime() - 86400000);
            }
        }

        return res.json({ checkedInToday, lastCheckin: todayCheckin, diasSemCheckin, streak });
    } catch (err) {
        console.error('[checkin/status]', err.message);
        return res.status(500).json({ erro: 'Erro ao buscar status.' });
    }
});

// ── Execução de Treino (F15) ──────────────────────────────────────────────────

// GET /treinos/execucao — página fullscreen de execução
router.get('/treinos/execucao', requirePlano, async (req, res) => {
    const userId  = req.session.user.id;
    const planoId = parseInt(req.query.plano_id, 10);
    if (!planoId) return res.redirect('/treinos');

    let plano;
    try {
        const [rows] = await db.execute(
            'SELECT * FROM workout_plans WHERE id = ? AND user_id = ?',
            [planoId, userId]
        );
        if (!rows.length) return res.redirect('/treinos');
        plano = rows[0];
        plano.exercicios_json = typeof plano.exercicios_json === 'string'
            ? JSON.parse(plano.exercicios_json)
            : (plano.exercicios_json || []);
    } catch (err) {
        console.error('[execucao]', err.message);
        return res.redirect('/treinos');
    }

    // Enriquecer exercícios com GIF, músculos e instruções
    try {
        const [exRows] = await db.execute(`
            SELECT e.name, e.target_muscle, e.body_part, e.instructions_json,
                   em.cloudinary_gif_url
            FROM exercises e
            LEFT JOIN exercise_media em ON em.exercise_id = e.id
        `);
        const exList = exRows.map(r => ({
            name:          r.name,
            gif_url:       r.cloudinary_gif_url || null,
            target_muscle: r.target_muscle || null,
            body_part:     r.body_part || null,
            instructions:  safeJson(r.instructions_json, []),
        }));
        const fuse = new Fuse(exList, { keys: ['name'], threshold: 0.4 });

        for (const ex of plano.exercicios_json) {
            const q     = (ex.exercise_query || '').toLowerCase().trim();
            const exact = exList.find(r => r.name.toLowerCase() === q);
            const match = exact || (fuse.search(ex.exercise_query || '')[0]?.item);
            ex.gif_url       = match?.gif_url       ?? null;
            ex.target_muscle = match?.target_muscle ?? null;
            ex.body_part     = match?.body_part     ?? null;
            ex.instructions  = match?.instructions  ?? [];
        }
    } catch (err) {
        console.error('[execucao/enrich]', err.message);
    }

    // Verificar sessão em andamento hoje
    let sessaoExistente = null;
    try {
        const [sRows] = await db.execute(`
            SELECT ts.id, ts.iniciado_em,
                   COALESCE(
                     (SELECT JSON_ARRAYAGG(
                        JSON_OBJECT('exercise_query', tse.exercise_query,
                                    'series_realizadas', tse.series_realizadas,
                                    'carga_usada', tse.carga_usada,
                                    'concluido', tse.concluido))
                      FROM treino_sessao_exercicio tse WHERE tse.sessao_id = ts.id
                     ), JSON_ARRAY()
                   ) AS exercicios_status
            FROM treino_sessao ts
            WHERE ts.user_id = ? AND ts.workout_plan_id = ?
              AND ts.status = 'em_andamento' AND DATE(ts.iniciado_em) = CURDATE()
            LIMIT 1
        `, [userId, planoId]);
        if (sRows.length) {
            sessaoExistente = sRows[0];
            sessaoExistente.exercicios_status = typeof sessaoExistente.exercicios_status === 'string'
                ? JSON.parse(sessaoExistente.exercicios_status)
                : (sessaoExistente.exercicios_status || []);
        }
    } catch (err) {
        console.error('[execucao/sessao]', err.message);
    }

    res.render('pages/execucao-treino', {
        user:            req.session.user,
        plano,
        sessaoExistente,
        seo: {
            title:       `${plano.nome} — FitCrew`,
            canonical:   `/treinos/execucao?plano_id=${planoId}`,
            robots:      'noindex, nofollow',
            description: 'Modo de execução de treino.',
        },
    });
});

// POST /treinos/sessao/iniciar
router.post('/treinos/sessao/iniciar', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { workout_plan_id } = req.body;
    if (!workout_plan_id) return res.status(400).json({ erro: 'workout_plan_id obrigatório.' });
    try {
        const [planRows] = await db.execute(
            'SELECT id, exercicios_json FROM workout_plans WHERE id = ? AND user_id = ?',
            [workout_plan_id, userId]
        );
        if (!planRows.length) return res.status(404).json({ erro: 'Plano não encontrado.' });

        const [existing] = await db.execute(`
            SELECT id FROM treino_sessao
            WHERE user_id = ? AND workout_plan_id = ?
              AND status = 'em_andamento' AND DATE(iniciado_em) = CURDATE()
            LIMIT 1
        `, [userId, workout_plan_id]);

        if (existing.length) {
            const [exRows] = await db.execute(
                'SELECT * FROM treino_sessao_exercicio WHERE sessao_id = ?',
                [existing[0].id]
            );
            return res.json({ sessao_id: existing[0].id, exercicios: exRows, retomada: true });
        }

        const [result] = await db.execute(
            'INSERT INTO treino_sessao (user_id, workout_plan_id) VALUES (?, ?)',
            [userId, workout_plan_id]
        );
        const sessaoId   = result.insertId;
        const exercicios = safeJson(planRows[0].exercicios_json, []);
        for (const ex of exercicios) {
            if (ex.exercise_query) {
                await db.execute(
                    'INSERT IGNORE INTO treino_sessao_exercicio (sessao_id, exercise_query) VALUES (?, ?)',
                    [sessaoId, ex.exercise_query]
                );
            }
        }
        const [exRows] = await db.execute(
            'SELECT * FROM treino_sessao_exercicio WHERE sessao_id = ?',
            [sessaoId]
        );
        return res.json({ sessao_id: sessaoId, exercicios: exRows, retomada: false });
    } catch (err) {
        console.error('[sessao/iniciar]', err.message);
        return res.status(500).json({ erro: 'Erro ao iniciar sessão.' });
    }
});

// POST /treinos/sessao/exercicio/concluir
router.post('/treinos/sessao/exercicio/concluir', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { sessao_id, exercise_query, series_realizadas, carga_usada } = req.body;
    if (!sessao_id || !exercise_query) return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
    try {
        const [sRows] = await db.execute(
            "SELECT id FROM treino_sessao WHERE id = ? AND user_id = ? AND status = 'em_andamento'",
            [sessao_id, userId]
        );
        if (!sRows.length) return res.status(404).json({ erro: 'Sessão não encontrada.' });

        await db.execute(`
            INSERT INTO treino_sessao_exercicio (sessao_id, exercise_query, series_realizadas, carga_usada, concluido)
            VALUES (?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                series_realizadas = VALUES(series_realizadas),
                carga_usada       = VALUES(carga_usada),
                concluido         = 1
        `, [sessao_id, exercise_query, series_realizadas || 0, carga_usada || null]);

        // Verificar conquistas de peso/cardio
        const novasConquistas = [];
        try {
            const [exRows] = await db.execute(
                'SELECT body_part FROM exercises WHERE LOWER(name) = LOWER(?) LIMIT 1',
                [exercise_query]
            );
            const bodyPart = exRows[0]?.body_part || null;
            const pesoKg   = parseFloat(String(carga_usada || '').replace(/[^\d.]/g, '')) || 0;
            if (bodyPart) {
                if (bodyPart === 'cardio' && pesoKg > 0) {
                    const nc = await conquistas.verificarCardio(userId, pesoKg);
                    novasConquistas.push(...nc);
                } else if (pesoKg > 0) {
                    const nc = await conquistas.verificarPeso(userId, bodyPart, pesoKg);
                    novasConquistas.push(...nc);
                }
            }
        } catch (e) {
            console.error('[sessao/exercicio/concluir] conquistas:', e.message);
        }

        let novasDetalhes = [];
        if (novasConquistas.length) {
            const placeholders = novasConquistas.map(() => '?').join(',');
            const [detalhes] = await db.execute(
                `SELECT slug, nome, tier, icone FROM conquistas WHERE slug IN (${placeholders})`,
                novasConquistas
            );
            novasDetalhes = detalhes;
        }
        return res.json({ ok: true, novasConquistas: novasDetalhes });
    } catch (err) {
        console.error('[sessao/exercicio/concluir]', err.message);
        return res.status(500).json({ erro: 'Erro ao concluir exercício.' });
    }
});

// POST /treinos/sessao/abandonar
router.post('/treinos/sessao/abandonar', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { sessao_id } = req.body;
    if (!sessao_id) return res.status(400).json({ erro: 'sessao_id obrigatório.' });
    try {
        await db.execute(
            "UPDATE treino_sessao SET status = 'abandonado', finalizado_em = NOW() WHERE id = ? AND user_id = ?",
            [sessao_id, userId]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[sessao/abandonar]', err.message);
        return res.status(500).json({ erro: 'Erro ao abandonar sessão.' });
    }
});

// POST /treinos/sessao/finalizar
router.post('/treinos/sessao/finalizar', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { sessao_id } = req.body;
    if (!sessao_id) return res.status(400).json({ erro: 'sessao_id obrigatório.' });
    try {
        const [sRows] = await db.execute(
            "SELECT id FROM treino_sessao WHERE id = ? AND user_id = ? AND status = 'em_andamento'",
            [sessao_id, userId]
        );
        if (!sRows.length) return res.status(404).json({ erro: 'Sessão não encontrada ou já finalizada.' });

        await db.execute(
            "UPDATE treino_sessao SET status = 'completo', finalizado_em = NOW() WHERE id = ?",
            [sessao_id]
        );

        const [chkExisting] = await db.execute(
            'SELECT id FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1',
            [userId]
        );
        if (!chkExisting.length) {
            await db.execute('INSERT INTO treino_checkins (user_id) VALUES (?)', [userId]);
        }

        // Verificar conquistas: peso/cardio de todos os exercícios + consistência
        const novasSlugs = [];
        try {
            const [exRows] = await db.execute(
                `SELECT tse.carga_usada, e.body_part
                 FROM treino_sessao_exercicio tse
                 LEFT JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
                 WHERE tse.sessao_id = ? AND tse.concluido = 1`,
                [sessao_id]
            );
            for (const ex of exRows) {
                const grupo  = ex.body_part;
                const pesoKg = parseFloat(String(ex.carga_usada || '').replace(/[^\d.]/g, '')) || 0;
                if (grupo && pesoKg > 0) {
                    const nc = grupo === 'cardio'
                        ? await conquistas.verificarCardio(userId, pesoKg)
                        : await conquistas.verificarPeso(userId, grupo, pesoKg);
                    novasSlugs.push(...nc);
                }
            }
        } catch (e) {
            console.error('[sessao/finalizar] peso:', e.message);
        }
        const ncConsist = await conquistas.verificarConsistencia(userId).catch(() => []);
        novasSlugs.push(...ncConsist);

        let novasConquistas = [];
        if (novasSlugs.length) {
            const placeholders = novasSlugs.map(() => '?').join(',');
            const [detalhes] = await db.execute(
                `SELECT slug, nome, tier, icone FROM conquistas WHERE slug IN (${placeholders})`,
                novasSlugs
            );
            novasConquistas = detalhes;
        }

        return res.json({ ok: true, novasConquistas });
    } catch (err) {
        console.error('[sessao/finalizar]', err.message);
        return res.status(500).json({ erro: 'Erro ao finalizar sessão.' });
    }
});

// GET /treinos/sessao/historico
router.get('/treinos/sessao/historico', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [rows] = await db.execute(`
            SELECT ts.id, ts.iniciado_em, ts.finalizado_em,
                   wp.nome AS plano_nome,
                   TIMESTAMPDIFF(MINUTE, ts.iniciado_em, ts.finalizado_em) AS duracao_min,
                   COUNT(tse.id) AS total_exercicios,
                   SUM(tse.concluido) AS exercicios_concluidos
            FROM treino_sessao ts
            JOIN workout_plans wp ON wp.id = ts.workout_plan_id
            LEFT JOIN treino_sessao_exercicio tse ON tse.sessao_id = ts.id
            WHERE ts.user_id = ? AND ts.status = 'completo'
            GROUP BY ts.id, ts.iniciado_em, ts.finalizado_em, wp.nome
            ORDER BY ts.finalizado_em DESC
            LIMIT 10
        `, [userId]);
        return res.json({ ok: true, historico: rows });
    } catch (err) {
        console.error('[sessao/historico]', err.message);
        return res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
});

// POST /internal/checkin-alerts — lista usuários com 3+ dias sem check-in (Web Push vem na F10)
router.post('/internal/checkin-alerts', async (req, res) => {
    if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
        return res.status(401).json({ erro: 'Não autorizado.' });
    }
    try {
        const [users] = await db.execute(`
            SELECT u.id, u.nome, u.email,
                   MAX(tc.created_at)                        AS ultimo_checkin,
                   DATEDIFF(NOW(), MAX(tc.created_at))       AS dias_sem_checkin
            FROM user u
            LEFT JOIN treino_checkins tc ON tc.user_id = u.id
            WHERE u.status = 'ativo'
            GROUP BY u.id, u.nome, u.email
            HAVING dias_sem_checkin >= 3 OR ultimo_checkin IS NULL
        `);
        return res.json({ ok: true, usersToNotify: users });
    } catch (err) {
        console.error('[checkin-alerts]', err.message);
        return res.status(500).json({ erro: 'Erro interno.' });
    }
});

//Evolução
router.get('/evolucao', requirePlano, async (req, res) => {
    const uid = req.session.user.id;
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    let checkins = [], workoutLogs = [], measurements = [];
    try {
        [[checkins], [workoutLogs], [measurements]] = await Promise.all([
            db.execute(
                `SELECT data, dia_semana, COUNT(*) as total
                 FROM checkin
                 WHERE user_id = ? AND data >= CURDATE() - INTERVAL 30 DAY
                 GROUP BY data, dia_semana
                 ORDER BY data ASC`,
                [uid]
            ),
            db.execute(
                `SELECT wl.*, w.nome as workout_nome
                 FROM workout_log wl
                 LEFT JOIN workout w ON w.id = wl.workout_id
                 WHERE wl.user_id = ? AND wl.data >= CURDATE() - INTERVAL 30 DAY
                 ORDER BY wl.data DESC`,
                [uid]
            ),
            db.execute(
                `SELECT * FROM measurement WHERE user_id = ? ORDER BY data DESC LIMIT 10`,
                [uid]
            ),
        ]);
    } catch (err) {
        console.error('[evolucao]', err);
    }

    const contPorDia = [0, 0, 0, 0, 0, 0, 0];
    checkins.forEach(c => {
        const d = new Date(c.data);
        contPorDia[d.getDay()] += Number(c.total) || 0;
    });

    let exerciciosExecutados = [], volumeSemanal = [];
    try {
        [exerciciosExecutados] = await db.execute(`
            SELECT DISTINCT e.id, e.name, e.name_pt, e.name_es, e.body_part
            FROM treino_sessao_exercicio tse
            JOIN treino_sessao ts ON ts.id = tse.sessao_id
            JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
            WHERE ts.user_id = ? AND ts.status = 'completo'
              AND tse.carga_usada IS NOT NULL AND tse.carga_usada != ''
              AND (tse.carga_usada + 0) > 0
            ORDER BY e.name ASC
        `, [uid]);
    } catch (err) { console.error('[evolucao/exercicios]', err); }

    try {
        [volumeSemanal] = await db.execute(`
            SELECT
              YEARWEEK(ts.finalizado_em, 1) AS semana,
              MIN(DATE(ts.finalizado_em)) AS inicio_semana,
              COUNT(DISTINCT ts.id) AS sessoes,
              COUNT(tse.id) AS series_totais
            FROM treino_sessao ts
            JOIN treino_sessao_exercicio tse ON tse.sessao_id = ts.id
            WHERE ts.user_id = ?
              AND ts.status = 'completo'
              AND ts.finalizado_em >= DATE_SUB(NOW(), INTERVAL 8 WEEK)
            GROUP BY YEARWEEK(ts.finalizado_em, 1)
            ORDER BY semana ASC
        `, [uid]);
    } catch (err) { console.error('[evolucao/volume]', err); }

    res.render('pages/evolucao', {
        user: req.session.user,
        checkins,
        workoutLogs,
        measurements,
        graficoLabels: JSON.stringify(diasSemana),
        graficoData:   JSON.stringify(contPorDia),
        exerciciosExecutados,
        volumeSemanal,
        locale: req.locale || 'pt',
        seo: { title: 'Minha Evolução — FitCrew', canonical: '/evolucao', robots: 'noindex, nofollow', description: 'Acompanhe sua evolução física no FitCrew.' },
    });
});

// GET /api/evolucao/exercicio/:id — histórico de carga de um exercício
router.get('/api/evolucao/exercicio/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [historico] = await db.execute(`
            SELECT
              DATE(ts.finalizado_em) AS data,
              MAX(tse.carga_usada + 0) AS carga_maxima
            FROM treino_sessao ts
            JOIN treino_sessao_exercicio tse ON tse.sessao_id = ts.id
            JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
            WHERE ts.user_id = ?
              AND e.id = ?
              AND ts.status = 'completo'
              AND (tse.carga_usada + 0) > 0
            GROUP BY DATE(ts.finalizado_em)
            ORDER BY data ASC
            LIMIT 30
        `, [userId, req.params.id]);
        res.json(historico);
    } catch (err) {
        console.error('[api/evolucao/exercicio]', err);
        res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
});

// Meu Plano
router.get('/meu-plano', requirePlano, async (req, res) => {
    const user = req.session.user;
    try {
        const planoRows  = await User.getActivePlan(user.id);
        const todosPlanos = await Plan.findAll({ activeOnly: true });
        const planoBase   = planoRows || todosPlanos[1] || todosPlanos[0];

        const beneficios = (() => { try { return JSON.parse(planoBase.beneficios || '[]'); } catch { return []; } })();

        const renovacao = new Date();
        renovacao.setDate(renovacao.getDate() + 30);
        const renovacaoStr = renovacao.toLocaleDateString('pt-BR');
        const tempoRestanteDias = 30;
        const progresso = 5;

        const planoAtual = {
            nome:              planoBase.nome.toUpperCase(),
            descricao:         planoBase.descricao,
            beneficios,
            preco:             `R$ ${Number(planoBase.preco).toFixed(2).replace('.', ',')}`,
            periodo:           'mês',
            renovacao:         renovacaoStr,
            tempoRestanteDias,
            progresso,
        };

        const maxPreco = Math.max(...todosPlanos.map(x => Number(x.preco)));
        const outrosPlanos = todosPlanos
            .filter(p => p.id !== planoBase.id)
            .map(p => {
                const ben = (() => { try { return JSON.parse(p.beneficios || '[]'); } catch { return []; } })();
                return {
                    nome:       p.nome.toUpperCase(),
                    descricao:  p.descricao,
                    beneficios: ben,
                    preco:      `R$ ${Number(p.preco).toFixed(2).replace('.', ',')}`,
                    periodo:    'mês',
                    destaque:   Number(p.preco) === maxPreco,
                };
            });

        res.render('pages/meu-plano', { user, planoAtual, outrosPlanos,
            seo: { title: 'Meu Plano — FitCrew', canonical: '/meu-plano', robots: 'noindex, nofollow', description: 'Gerencie seu plano FitCrew.' },
        });
    } catch (err) {
        console.error('[meu-plano]', err);
        res.status(500).send('Erro ao carregar plano.');
    }
});

//Configurações (só requer login, não exige plano ativo)
router.get('/config', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT notification_interval_days, webauthn_enabled, deletion_scheduled_at, status FROM user WHERE id = ?',
            [req.session.user.id]
        );
        if (rows[0]) {
            req.session.user.notification_interval_days = rows[0].notification_interval_days ?? 7;
            req.session.user.webauthn_enabled           = rows[0].webauthn_enabled ?? 0;
            req.session.user.deletion_scheduled_at      = rows[0].deletion_scheduled_at || null;
            req.session.user.status                     = rows[0].status;
            if (rows[0].status === 'pendente_exclusao' && rows[0].deletion_scheduled_at) {
                req.session.user.diasRestantesExclusao = Math.ceil(
                    (new Date(rows[0].deletion_scheduled_at) - Date.now()) / 86400000
                );
            }
        }
    } catch (_) { /* mantém valor da sessão se houver */ }

    res.render('pages/config', { user: req.session.user,
        seo: { title: 'Configurações — FitCrew', canonical: '/config', robots: 'noindex, nofollow', description: 'Configurações da conta FitCrew.' },
    });
});

//Perfil IMC
router.get('/imc-form', requirePlano, async (req, res) => {
    let ultimoImc = null;
    try {
        const [imcRows] = await db.execute(
            `SELECT * FROM imc_profile WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
            [req.session.user.id]
        );
        if (imcRows[0]) {
            const r = imcRows[0];
            ultimoImc = {
                peso:                  r.peso,
                altura:                r.altura,
                imcValor:              r.imc_valor,
                idade:                 r.idade,
                sexo:                  r.sexo,
                objetivo:              r.objetivo,
                experiencia:           r.experiencia,
                diasSemana:            r.dias_semana,
                tempoPorSessao:        r.tempo_por_sessao,
                localTreino:           r.local_treino,
                lesoes:                safeJson(r.lesoes, []),
                restricoesAlimentares: safeJson(r.restricoes_alimentares, []),
                suplementacao:         safeJson(r.suplementacao, []),
                hidratacao:            r.hidratacao,
                seletividade:          r.seletividade,
                alimentosSeletividade: r.alimentos_seletividade || '',
            };
        }
    } catch (err) {
        console.error('[imc-form]', err);
    }
    res.render('pages/imc-form', { user: req.session.user, ultimoImc,
        primeiro: req.query.primeiro === '1',
        seo: { title: 'Meu Perfil IMC — FitCrew', canonical: '/imc-form', robots: 'noindex, nofollow', description: 'Perfil IMC personalizado FitCrew.' },
    });
});

//Avaliação Corporal
router.get('/ai/avaliacao', requirePlanLevel(['black']), async (req, res) => {
    let avaliacoes = [];
    try {
        const [rows] = await db.execute(
            `SELECT * FROM body_photo WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
            [req.session.user.id]
        );
        avaliacoes = rows.map(r => ({
            ...r,
            analise: safeJson(r.analise_raw, null),
            data_fmt: new Date(r.created_at).toLocaleDateString('pt-BR'),
        }));
    } catch (err) {
        console.error('[ai/avaliacao GET]', err);
    }
    res.render('pages/ai-avaliacao', { user: req.session.user, avaliacoes });
});

// Atualizar e-mail nas configurações
router.post('/config/atualizar-dados', requireAuth,
  [
    body('email').isEmail().withMessage('E-mail inválido.').normalizeEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { email } = req.body;
    const user = req.session.user;
    try {
        const dup = await User.findByEmail(email);
        if (dup && dup.id !== user.id) return res.status(400).json({ erro: 'E-mail já cadastrado.' });

        await User.update(user.id, { email });
        req.session.user = { ...user, email };
        return res.json({ mensagem: 'E-mail atualizado com sucesso!' });
    } catch (err) {
        console.error('[config/atualizar-dados]', err);
        return res.status(500).json({ erro: 'Erro ao atualizar dados.' });
    }
});

// Alterar senha
router.post('/config/alterar-senha', requireAuth,
  [
    body('senhaAtual').notEmpty().withMessage('Senha atual obrigatória.'),
    body('novaSenha').isLength({ min: 6 }).withMessage('A nova senha deve ter pelo menos 6 caracteres.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { senhaAtual, novaSenha } = req.body;
    const user = req.session.user;
    try {
        const userRow = await User.findById(user.id);
        if (!userRow) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        const ok = await bcrypt.compare(senhaAtual, userRow.senha_hash);
        if (!ok) return res.status(400).json({ erro: 'Senha atual incorreta.' });
        const novaHash = await bcrypt.hash(novaSenha, 10);
        await User.update(user.id, { senha_hash: novaHash });
        return res.json({ mensagem: 'Senha alterada com sucesso!' });
    } catch (err) {
        console.error('[config/alterar-senha]', err);
        return res.status(500).json({ erro: 'Erro ao alterar senha.' });
    }
});

// Alterar plano (redirecionamento para pagamento — não muda diretamente)
router.post('/config/alterar-plano', requireAuth, (req, res) => {
    return res.json({ mensagem: 'Redirecionando para pagamento...' });
});

// Upload de foto de perfil
router.post('/api/student/profile-photo', (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });
    next();
}, photoUpload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const photoUrl = req.file.path; // URL do Cloudinary
    const user = req.session.user;
    try {
        await db.execute('UPDATE user SET profile_photo = ? WHERE id = ?', [photoUrl, user.id]);
        req.session.user = { ...user, profile_photo: photoUrl };
        return res.json({ mensagem: 'Foto atualizada com sucesso!', photoUrl });
    } catch (err) {
        console.error('[profile-photo]', err);
        return res.status(500).json({ erro: 'Erro ao salvar foto.' });
    }
}, (err, _req, res, _next) => {
    return res.status(400).json({ erro: err.message });
});



router.post('/imc-save', requireAuth, async (req, res) => {
    const {
        lesoes, restricoesAlimentares, gruposAlimentares, suplementacao,
        peso, altura, idade, sexo, objetivo, experiencia,
        diasSemana, tempoPorSessao, localTreino, hidratacao,
        seletividade, alimentosSeletividade,
    } = req.body;

    const toArr = v => Array.isArray(v) ? v : (v ? [v] : []);

    const lesoesArr   = toArr(lesoes);
    const restricArr  = toArr(restricoesAlimentares);
    const gruposArr   = toArr(gruposAlimentares);
    const suplArr     = toArr(suplementacao);

    const alturaM   = Number(altura) > 3 ? Number(altura) / 100 : Number(altura);
    const pesoN     = Number(peso);
    const imc       = alturaM > 0 ? (pesoN / (alturaM * alturaM)).toFixed(1) : null;

    try {
        await db.execute(
            `INSERT INTO imc_profile
             (user_id, peso, altura, imc_valor, idade, sexo, objetivo,
              experiencia, dias_semana, tempo_por_sessao, local_treino,
              lesoes, restricoes_alimentares, suplementacao, hidratacao)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.id,
                pesoN, alturaM, imc, Number(idade), sexo, objetivo,
                experiencia, Number(diasSemana), tempoPorSessao, localTreino,
                JSON.stringify(lesoesArr), JSON.stringify(restricArr),
                JSON.stringify(suplArr), hidratacao,
            ]
        );

        await db.execute(
            'UPDATE user SET peso = ?, altura = ?, imc = ?, objetivo = ?, last_imc_update = NOW() WHERE id = ?',
            [pesoN, alturaM, imc, objetivo, req.session.user.id]
        );

        req.session.user.imc = {
            peso: pesoN, altura, imcValor: imc, idade, sexo, objetivo,
            experiencia, diasSemana, tempoPorSessao, localTreino,
            lesoes: lesoesArr, restricoesAlimentares: restricArr,
            gruposAlimentares: gruposArr, suplementacao: suplArr,
            hidratacao, seletividade, alimentosSeletividade,
        };

        return res.json({ mensagem: 'Perfil salvo com sucesso! Redirecionando...', redirect: '/area-aluno' });
    } catch (err) {
        console.error('[imc-save]', err);
        return res.status(500).json({ erro: 'Erro ao salvar perfil.' });
    }
});

// Conquistas do aluno
router.get('/conquistas', requirePlano, async (req, res) => {
    try {
        const lista = await conquistas.getConquistasUsuario(req.session.user.id);
        const totalDesbloqueadas = lista.filter(c => c.desbloqueada).length;
        res.render('pages/conquistas', {
            user: req.session.user,
            lista,
            totalDesbloqueadas,
            total: lista.length,
            seo: { title: 'Minhas Conquistas — FitCrew', canonical: '/conquistas', robots: 'noindex, nofollow', description: 'Suas conquistas no FitCrew.' },
        });
    } catch (err) {
        console.error('[conquistas]', err.message);
        res.redirect('/area-aluno');
    }
});

// Editar perfil — GET
router.get('/perfil/editar', requireAuth, async (req, res) => {
    const uid = req.session.user.id;
    try {
        const [[usuario]] = await db.execute(
            'SELECT nome, username, bio, instagram_username, profile_photo, medalhas_destaque FROM user WHERE id = ?',
            [uid]
        );
        const [conquistasList] = await db.execute(
            `SELECT c.slug, c.nome, c.icone, c.tier
             FROM usuario_conquistas uc
             JOIN conquistas c ON c.id = uc.conquista_id
             WHERE uc.user_id = ?
             ORDER BY c.tier DESC, c.nome ASC`,
            [uid]
        );
        const medalhasDestaque = safeJson(usuario.medalhas_destaque, []);
        res.render('pages/editar-perfil', {
            user:           req.session.user,
            usuario,
            conquistas:     conquistasList,
            medalhasDestaque,
            query:          req.query,
            seo: { title: 'Editar Perfil — FitCrew', robots: 'noindex' },
        });
    } catch (err) {
        console.error('[perfil/editar GET]', err.message);
        res.redirect('/area-aluno');
    }
});

// Editar perfil — POST
router.post('/perfil/editar', requireAuth, photoUpload.single('foto'), async (req, res) => {
    const uid = req.session.user.id;
    const { nome, username, bio, instagram_username } = req.body;

    if (username && !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.redirect('/perfil/editar?erro=username_invalido');
    }

    try {
        if (username) {
            const [[existing]] = await db.execute(
                'SELECT id FROM user WHERE username = ? AND id != ?',
                [username, uid]
            );
            if (existing) return res.redirect('/perfil/editar?erro=username_taken');
        }

        let medalhasArr = [];
        const raw = req.body.medalhas_destaque;
        if (raw) {
            medalhasArr = (Array.isArray(raw) ? raw : [raw]).slice(0, 3);
        }

        const fields = {
            nome:               nome?.trim() || req.session.user.nome,
            username:           username?.trim() || null,
            bio:                bio?.trim().slice(0, 150) || null,
            instagram_username: instagram_username?.replace('@', '').trim() || null,
            medalhas_destaque:  JSON.stringify(medalhasArr),
        };

        if (req.file) fields.profile_photo = req.file.path;

        await User.update(uid, fields);
        req.session.user = { ...req.session.user, ...fields };

        const destino = username?.trim() || String(uid);
        res.redirect(`/perfil/${destino}?salvo=1`);
    } catch (err) {
        console.error('[perfil/editar POST]', err.message);
        res.redirect('/perfil/editar?erro=servidor');
    }
}, (err, _req, res, _next) => {
    console.error('[perfil/editar upload]', err.message);
    res.redirect('/perfil/editar?erro=foto_invalida');
});

// Perfil público — acessível sem login
router.get('/perfil/:id', async (req, res) => {
    try {
        const param = req.params.id;
        const isNumeric = /^\d+$/.test(param);
        const [uRows] = await db.execute(
            isNumeric
                ? 'SELECT id, nome, username, bio, profile_photo, status, created_at, instagram_username FROM user WHERE id = ? AND status = "ativo"'
                : 'SELECT id, nome, username, bio, profile_photo, status, created_at, instagram_username FROM user WHERE username = ? AND status = "ativo"',
            [param]
        );
        if (!uRows.length) return res.status(404).render('pages/404', { user: req.session.user || null });
        const u = uRows[0];

        const lista       = await conquistas.getConquistasUsuario(u.id);
        const desbloqueadas = lista.filter(c => c.desbloqueada);

        const [[{ totalSessoes }]] = await db.execute(
            'SELECT COUNT(*) as totalSessoes FROM treino_sessao WHERE user_id = ? AND status = "completo"',
            [u.id]
        );

        const [checkinRows] = await db.execute(
            `SELECT DATE(created_at) as dia FROM treino_checkins
             WHERE user_id = ? GROUP BY DATE(created_at) ORDER BY dia DESC LIMIT 60`,
            [u.id]
        );
        let streak = 0;
        let diaAnterior = null;
        for (const row of checkinRows) {
            const dia = new Date(row.dia);
            if (!diaAnterior) { streak = 1; }
            else {
                const diff = (diaAnterior - dia) / (1000 * 60 * 60 * 24);
                if (diff === 1) streak++;
                else break;
            }
            diaAnterior = dia;
        }

        const [conquistasHero] = await db.execute(
            `SELECT c.slug, c.nome, c.tier, c.icone
             FROM usuario_conquistas uc
             JOIN conquistas c ON c.id = uc.conquista_id
             WHERE uc.user_id = ?
             ORDER BY uc.desbloqueada_em DESC LIMIT 3`,
            [u.id]
        );

        const isProprioPerfilId = !!(req.session.user && String(req.session.user.id) === String(u.id));

        res.render('pages/perfil-publico', {
            user:              req.session.user || null,
            perfil:            u,
            conquistas:        desbloqueadas,
            conquistasHero,
            totalSessoes,
            streak,
            isProprioPerfilId,
            seo: { title: `Perfil de ${u.nome} — FitCrew`, canonical: `/perfil/${u.id}`, description: `Veja as conquistas de ${u.nome} no FitCrew.` },
        });
    } catch (err) {
        console.error('[perfil]', err.message);
        res.status(500).redirect('/');
    }
});

// Suporte (área do aluno)
router.get('/suporte', requirePlano, (req, res) => {
    res.render('pages/suporte', { user: req.session.user, seo: {
        title: 'Suporte — FitCrew', canonical: '/suporte',
        robots: 'noindex, nofollow', description: 'Central de suporte FitCrew.',
    }});
});

router.post('/api/suporte/tickets', requireAuth, [
    body('assunto').trim().notEmpty().withMessage('Assunto obrigatório.').isLength({ max: 150 }),
    body('descricao').trim().notEmpty().withMessage('Descrição obrigatória.').isLength({ max: 2000 }),
    body('tipo').optional().isLength({ max: 100 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { assunto, descricao, tipo } = req.body;
    const user = req.session.user;

    try {
        const [result] = await db.execute(
            `INSERT INTO ticket (user_id, assunto, mensagem, tipo, status, created_at)
             VALUES (?, ?, ?, ?, 'aberto', NOW())`,
            [user.id, assunto, descricao, tipo || 'Outro']
        );
        broadcast('novo_ticket', { userId: user.id, nome: user.nome, assunto });
        return res.json({ ok: true, mensagem: 'Ticket enviado com sucesso!', ticket: { id: result.insertId, assunto, status: 'aberto' } });
    } catch (err) {
        console.error('[suporte/tickets]', err.message);
        return res.status(500).json({ erro: 'Erro ao enviar ticket.' });
    }
});

router.get('/api/suporte/tickets', requireAuth, async (req, res) => {
    try {
        const [tickets] = await db.execute(
            'SELECT id, assunto, tipo, status, created_at FROM ticket WHERE user_id = ? ORDER BY created_at DESC',
            [req.session.user.id]
        );
        res.json(tickets);
    } catch (err) {
        console.error('[suporte/tickets/list]', err.message);
        res.status(500).json({ erro: 'Erro ao buscar tickets.' });
    }
});

router.get('/api/suporte/tickets/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const [[ticket]] = await db.execute(
            'SELECT id, assunto, tipo, status FROM ticket WHERE id = ? AND user_id = ?',
            [req.params.id, userId]
        );
        if (!ticket) return res.status(404).json({ erro: 'Ticket não encontrado.' });
        const [mensagens] = await db.execute(
            'SELECT id, remetente, texto, created_at FROM ticket_mensagem WHERE ticket_id = ? ORDER BY created_at ASC',
            [ticket.id]
        );
        res.json({ ...ticket, mensagens });
    } catch (err) {
        console.error('[suporte/tickets/get]', err.message);
        res.status(500).json({ erro: 'Erro ao buscar ticket.' });
    }
});

router.post('/api/suporte/tickets/:id/mensagem', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'Texto obrigatório.' });
    try {
        const [[ticket]] = await db.execute(
            "SELECT id FROM ticket WHERE id = ? AND user_id = ? AND status != 'fechado'",
            [req.params.id, userId]
        );
        if (!ticket) return res.status(404).json({ erro: 'Ticket não encontrado ou fechado.' });
        const [result] = await db.execute(
            "INSERT INTO ticket_mensagem (ticket_id, remetente, texto) VALUES (?, 'usuario', ?)",
            [ticket.id, texto.trim()]
        );
        const [[msg]] = await db.execute(
            'SELECT id, remetente, texto, created_at FROM ticket_mensagem WHERE id = ?',
            [result.insertId]
        );
        broadcast('ticket_mensagem', { ticketId: ticket.id, msg });
        res.json({ ...msg, criadaEm: msg.created_at });
    } catch (err) {
        console.error('[suporte/tickets/mensagem]', err.message);
        res.status(500).json({ erro: 'Erro ao enviar mensagem.' });
    }
});

router.get('/api/suporte/tickets/:id/stream', requireAuth, async (req, res) => {
    const userId   = req.session.user.id;
    const ticketId = parseInt(req.params.id, 10);
    try {
        const [[ticket]] = await db.execute(
            'SELECT id FROM ticket WHERE id = ? AND user_id = ?',
            [ticketId, userId]
        );
        if (!ticket) return res.status(404).end();
    } catch { return res.status(500).end(); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = `ticket_${ticketId}_${userId}_${Date.now()}`;
    if (!global.ticketClients) global.ticketClients = new Map();
    global.ticketClients.set(clientId, { res, ticketId });

    req.on('close', () => {
        global.ticketClients.delete(clientId);
    });
});

//Administração
router.get('/admin-dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-dashboard', { user: req.session.user });
});

//Checkin
router.get('/admin-checkins', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-checkins', { user: req.session.user });
});

//Admin Configurações
router.get('/admin-configuracoes', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-configuracoes', { user: req.session.user });
});

//Administração Login
router.get('/admin-login', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-login', { user: req.session.user });
});

//Administração Academias
router.get('/admin-academias', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-academias', { user: req.session.user });
});

//Administração Inadimplentes
router.get('/admin-financeiro-inadimplentes', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-financeiro-inadimplentes', { user: req.session.user });
});

//Administração Receitas
router.get('/admin-financeiro-receitas', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-financeiro-receitas', { user: req.session.user });
});

//Administração Financeiro
router.get('/admin-financeiro', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-financeiro', { user: req.session.user });
});

//Administração Notificações
router.get('/admin-notificacoes', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-notificacoes', { user: req.session.user });
});

//Administração Planos
router.get('/admin-planos', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-planos', { user: req.session.user });
});

//Administração Relatórios
router.get('/admin-relatorios', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-relatorios', { user: req.session.user });
});


//Administração Suporte Chat
router.get('/admin-suporte-chat', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-suporte-chat', { user: req.session.user });
});

//Administração Suporte
router.get('/admin-suporte', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-suporte', { user: req.session.user });
});

//Administração Usuário Perfil
router.get('/admin-usuario-perfil', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-usuario-perfil', { user: req.session.user });
});

//Administração Usuários
router.get('/admin-usuarios', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    res.render('pages/admin-usuarios', { user: req.session.user });
});

// Logout — POST evita logout acidental por crawler/prefetch
router.post('/logout', (req, res) => {
    const uid = (req.session.user?.cpf || '').replace(/\D/g, '');
    req.session.destroy(err => {
        if (err) console.error(err);
        res.clearCookie('connect.sid');
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>
try {
    ['gymbros_treinos_${uid}','gymbros_evolucao_${uid}','gymbros_imc_profile_${uid}'].forEach(k => localStorage.removeItem(k));
} catch(e){}
location.href='/';
</script></body></html>`);
    });
});

// Redireciona GET /logout para home (crawlers, bookmarks antigos)
router.get('/logout', (req, res) => {
    res.redirect('/');
});

// ====================
// ROTAS POST
// ====================

// Registro
router.post('/register',
  [
    body('nome').trim().notEmpty().withMessage('Nome obrigatório.').isLength({ min: 3 }).withMessage('Nome muito curto.'),
    body('cpf').custom(value => { if (!validarCPF(value)) throw new Error('CPF inválido.'); return true; }),
    body('email').isEmail().withMessage('E-mail inválido.'),
    body('cep').matches(/^\d{8}$/).withMessage('CEP deve ter 8 números.'),
    body('password').isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmPassword').custom((value, { req }) => {
        if (value !== req.body.password) throw new Error('As senhas não coincidem!');
        return true;
    }),
    body('terms').equals('on').withMessage('Você precisa aceitar os termos de uso.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { nome, email, cep, password, logradouro, numero, complemento, bairro, cidade, estado } = req.body;
    const cpf = req.body.cpf.replace(/\D/g, '');

    try {
        if (await User.findByCpf(cpf))    return res.status(400).json({ erros: [{ param: 'cpf',   msg: 'CPF já cadastrado.' }] });
        if (await User.findByEmail(email)) return res.status(400).json({ erros: [{ param: 'email', msg: 'E-mail já cadastrado.' }] });

        const senha_hash = await bcrypt.hash(password, 10);
        await User.create({ nome, cpf, email, senha_hash, cep, logradouro, numero, complemento, bairro, cidade, estado });
        return res.status(200).json({ mensagem: 'Cadastro realizado com sucesso! Redirecionando para o login...' });
    } catch (err) {
        console.error('[register]', err);
        return res.status(500).json({ erros: [{ msg: 'Erro interno ao cadastrar.' }] });
    }
  }
);

// Login
router.post('/login',
  [
    body('username').trim().notEmpty().withMessage('Usuário obrigatório.'),
    body('password').notEmpty().withMessage('Senha obrigatória.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ erros: errors.array() });

    const { username, password, redirect: redirectTo } = req.body;
    const identifier = username.trim();
    const cpfNorm    = identifier.replace(/\D/g, '');

    try {
        const user = await User.findActiveByIdentifier(identifier);
        if (!user || !(await bcrypt.compare(password, user.senha_hash))) {
            await db.execute(
                'INSERT INTO login_attempt (identificador, ip, sucesso) VALUES (?, ?, 0)',
                [identifier, req.ip]
            ).catch(() => {});
            return res.status(401).json({ erros: [{ param: 'password', msg: 'Usuário ou senha incorretos.' }] });
        }

        const [plano, imcRow, avalRow] = await Promise.all([
            User.getActivePlan(user.id),
            ImcProfile.findLatestByUser(user.id),
            BodyPhoto.findLatestByUser(user.id),
        ]);

        const imcData = imcRow ? {
            peso:                  imcRow.peso,
            altura:                imcRow.altura,
            imcValor:              imcRow.imc_valor,
            idade:                 imcRow.idade,
            sexo:                  imcRow.sexo,
            objetivo:              imcRow.objetivo,
            experiencia:           imcRow.experiencia,
            diasSemana:            imcRow.dias_semana,
            tempoPorSessao:        imcRow.tempo_por_sessao,
            localTreino:           imcRow.local_treino,
            lesoes:                safeJson(imcRow.lesoes, []),
            restricoesAlimentares: safeJson(imcRow.restricoes_alimentares, []),
            suplementacao:         safeJson(imcRow.suplementacao, []),
            hidratacao:            imcRow.hidratacao,
            seletividade:          imcRow.seletividade,
            alimentosSeletividade: imcRow.alimentos_seletividade,
        } : null;

        const avalRaw  = avalRow ? safeJson(avalRow.analise_raw, null) : null;
        const avalData = avalRaw ? {
            ...avalRaw,
            data: new Date(avalRow.created_at).toLocaleDateString('pt-BR'),
        } : null;

        const diasRestantesExclusao = (user.status === 'pendente_exclusao' && user.deletion_scheduled_at)
            ? Math.ceil((new Date(user.deletion_scheduled_at) - Date.now()) / 86400000)
            : null;

        req.session.user = {
            id:                         user.id,
            nome:                       user.nome,
            email:                      user.email,
            cpf:                        user.cpf,
            plano:                      plano?.nome  || null,
            planoId:                    plano?.id    || null,
            planoSlug:                  plano?.slug  || null,
            profile_photo:              user.profile_photo || null,
            status:                     user.status,
            deletion_scheduled_at:      user.deletion_scheduled_at      || null,
            diasRestantesExclusao,
            webauthn_enabled:           user.webauthn_enabled           || 0,
            last_imc_update:            user.last_imc_update            || null,
            last_avaliacao_update:      user.last_avaliacao_update      || null,
            notification_interval_days: user.notification_interval_days || 7,
            imc:                        imcData,
            avaliacaoCorporal:          avalData,
        };

        await db.execute(
            'INSERT INTO login_attempt (identificador, ip, sucesso) VALUES (?, ?, 1)',
            [identifier, req.ip]
        ).catch(() => {});

        broadcast('user_online', { id: user.id, nome: user.nome, email: user.email });

        const safeRedirect = (redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')) ? redirectTo : '/area-aluno';
        req.session.save(err => {
            if (err) {
                console.error('[login] session save error:', err);
                return res.status(500).json({ erros: [{ msg: 'Erro ao salvar sessão.' }] });
            }
            return res.status(200).json({ mensagem: 'Login realizado com sucesso! Redirecionando...', redirect: safeRedirect });
        });
    } catch (err) {
        console.error('[login]', err);
        return res.status(500).json({ erros: [{ msg: 'Erro interno ao autenticar.' }] });
    }
  }
);

// ====================
// SITEMAP
// ====================
router.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://gymbros.app.br/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://gymbros.app.br/planos</loc>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://gymbros.app.br/register</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://gymbros.app.br/about</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://gymbros.app.br/faq</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://gymbros.app.br/academias</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>`);
});

// ====================
// ARQUIVOS ESTÁTICOS
// ====================
router.get('/js/carrossel.js', (req, res) => res.sendFile(path.join(__dirname, '../public/js/carrossel.js')));
router.get('/js/header.js', (req, res) => res.sendFile(path.join(__dirname, '../public/js/header.js')));
router.get('/js/forms.js', (req, res) => res.sendFile(path.join(__dirname, '../public/js/forms.js')));
router.get('/js/area-aluno.js', (req, res) => res.sendFile(path.join(__dirname, '../public/js/area-aluno.js')));

// ====================
// NUTRIÇÃO
// ====================

// ── Helpers de nutrição ────────────────────────────────────────────────────────

async function recalcularLog(logId) {
    await db.execute(`
        UPDATE nutrition_log nl
        SET
            kcal       = (SELECT COALESCE(SUM(kcal), 0)       FROM nutrition_item WHERE log_id = ?),
            proteina_g = (SELECT COALESCE(SUM(proteina_g), 0) FROM nutrition_item WHERE log_id = ?),
            carbs_g    = (SELECT COALESCE(SUM(carbs_g), 0)    FROM nutrition_item WHERE log_id = ?),
            gordura_g  = (SELECT COALESCE(SUM(gordura_g), 0)  FROM nutrition_item WHERE log_id = ?),
            fibra_g    = (SELECT COALESCE(SUM(fibra_g), 0)    FROM nutrition_item WHERE log_id = ?)
        WHERE nl.id = ?
    `, [logId, logId, logId, logId, logId, logId]);
}

// ── GET /api/nutricao/buscar?q=frango&lang=pt ─────────────────────────────────
router.get('/api/nutricao/buscar', requireAuth, async (req, res) => {
    const query = (req.query.q || '').trim();
    const lang  = ['pt', 'en', 'es'].includes(req.query.lang)        ? req.query.lang
                : ['pt', 'en', 'es'].includes(req.cookies?.gymbros_lang) ? req.cookies.gymbros_lang
                : 'pt';
    if (query.length < 2) return res.json([]);
    try {
        const resultados = await searchAlimento(query, lang);
        res.json(resultados);
    } catch (err) {
        console.error('[nutricao/buscar]', err.message);
        res.status(500).json({ erro: 'Erro na busca.' });
    }
});

// ── POST /api/nutricao/refeicao — criar/obter log da refeição do dia ──────────
router.post('/api/nutricao/refeicao', requireAuth, async (req, res) => {
    const { refeicao_tipo, data: dataCliente, horario: horarioCliente } = req.body;
    const uid  = req.session.user.id;
    const hoje = dataCliente   || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const hora = horarioCliente || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });

    const tiposValidos = ['cafe', 'almoco', 'jantar', 'lanche', 'outro'];
    if (!tiposValidos.includes(refeicao_tipo)) {
        return res.status(400).json({ erro: 'Tipo de refeição inválido.' });
    }

    try {
        let [[log]] = await db.execute(
            'SELECT id FROM nutrition_log WHERE user_id = ? AND data = ? AND refeicao_tipo = ?',
            [uid, hoje, refeicao_tipo]
        );
        if (!log) {
            const nomes = { cafe: 'Café da manhã', almoco: 'Almoço', jantar: 'Jantar', lanche: 'Lanche', outro: 'Outro' };
            const refeicaoEnum = { cafe: 'cafe', almoco: 'almoco', jantar: 'jantar', lanche: 'lanche_tarde', outro: 'almoco' };
            const [result] = await db.execute(
                'INSERT INTO nutrition_log (user_id, descricao, refeicao, refeicao_tipo, registrado_em, horario, kcal, proteina_g, carbs_g, gordura_g, fibra_g) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
                [uid, nomes[refeicao_tipo] || 'Refeição', refeicaoEnum[refeicao_tipo] || 'almoco', refeicao_tipo, `${hoje} ${hora}`, hora]
            );
            log = { id: result.insertId };
        }
        res.json({ ok: true, log_id: log.id });
    } catch (err) {
        console.error('[nutricao/refeicao]', err.message);
        res.status(500).json({ erro: 'Erro ao criar refeição.' });
    }
});

// ── POST /api/nutricao/item — adicionar item a uma refeição ───────────────────
router.post('/api/nutricao/item', requireAuth, async (req, res) => {
    const uid = req.session.user.id;
    const { log_id, alimento_nome, quantidade_g, kcal_100g, proteina_100g, carbs_100g, gordura_100g, fibra_100g, fonte, fonte_id } = req.body;

    if (!log_id || !alimento_nome || !quantidade_g) {
        return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
    }

    const [[log]] = await db.execute(
        'SELECT id FROM nutrition_log WHERE id = ? AND user_id = ?',
        [log_id, uid]
    );
    if (!log) return res.status(404).json({ erro: 'Refeição não encontrada.' });

    const fator  = Number(quantidade_g) / 100;
    const kcal   = Math.round(Number(kcal_100g)     * fator * 10) / 10;
    const prot   = Math.round(Number(proteina_100g) * fator * 10) / 10;
    const carbs  = Math.round(Number(carbs_100g)    * fator * 10) / 10;
    const gord   = Math.round(Number(gordura_100g)  * fator * 10) / 10;
    const fibra  = Math.round(Number(fibra_100g)    * fator * 10) / 10;

    try {
        const [result] = await db.execute(
            'INSERT INTO nutrition_item (log_id, alimento_nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g, fonte, fonte_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [log_id, alimento_nome.trim(), Number(quantidade_g), kcal, prot, carbs, gord, fibra, fonte || 'manual', fonte_id || null]
        );
        await recalcularLog(log_id);
        const [[item]] = await db.execute('SELECT * FROM nutrition_item WHERE id = ?', [result.insertId]);
        res.status(201).json({ ok: true, item });
    } catch (err) {
        console.error('[nutricao/item]', err.message);
        res.status(500).json({ erro: 'Erro ao adicionar item.' });
    }
});

// ── DELETE /api/nutricao/item/:id ─────────────────────────────────────────────
router.delete('/api/nutricao/item/:id', requireAuth, async (req, res) => {
    const uid = req.session.user.id;
    try {
        const [[item]] = await db.execute(
            `SELECT ni.id, ni.log_id FROM nutrition_item ni
             JOIN nutrition_log nl ON nl.id = ni.log_id
             WHERE ni.id = ? AND nl.user_id = ?`,
            [req.params.id, uid]
        );
        if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

        await db.execute('DELETE FROM nutrition_item WHERE id = ?', [item.id]);
        await recalcularLog(item.log_id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[nutricao/item/delete]', err.message);
        res.status(500).json({ erro: 'Erro ao remover item.' });
    }
});

// ── GET /api/nutricao/itens/:logId ───────────────────────────────────────────
router.get('/api/nutricao/itens/:logId', requireAuth, async (req, res) => {
    const uid = req.session.user.id;
    try {
        const [[log]] = await db.execute(
            'SELECT id FROM nutrition_log WHERE id = ? AND user_id = ?',
            [req.params.logId, uid]
        );
        if (!log) return res.status(404).json({ erro: 'Log não encontrado.' });
        const [itens] = await db.execute(
            'SELECT id, alimento_nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g FROM nutrition_item WHERE log_id = ? ORDER BY id ASC',
            [req.params.logId]
        );
        res.json({ itens });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar itens.' });
    }
});

// ── GET /api/nutricao/historico?page=1 ───────────────────────────────────────
router.get('/api/nutricao/historico', requireAuth, async (req, res) => {
    const uid    = req.session.user.id;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limite = 10;
    const offset = (page - 1) * limite;

    try {
        const [dias] = await db.execute(`
            SELECT
                nl.data,
                SUM(nl.kcal)       AS total_kcal,
                SUM(nl.proteina_g) AS total_prot,
                SUM(nl.carbs_g)    AS total_carbs,
                SUM(nl.gordura_g)  AS total_gord
            FROM nutrition_log nl
            WHERE nl.user_id = ?
            GROUP BY nl.data
            ORDER BY nl.data DESC
            LIMIT ${Number(limite)} OFFSET ${Number(offset)}
        `, [uid]);

        for (const dia of dias) {
            const dataStr = new Date(dia.data).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
            const [logs] = await db.execute(
                `SELECT id, refeicao_tipo, horario, kcal
                 FROM nutrition_log
                 WHERE user_id = ? AND data = ?
                 ORDER BY horario ASC`,
                [uid, dataStr]
            );
            for (const log of logs) {
                const [itens] = await db.execute(
                    `SELECT id, alimento_nome, quantidade_g, kcal, proteina_g
                     FROM nutrition_item WHERE log_id = ?`,
                    [log.id]
                );
                log.itens = itens;
            }
            dia.logs = logs.filter(l => l.itens.length > 0);
        }

        const [[{ total }]] = await db.execute(
            'SELECT COUNT(DISTINCT data) as total FROM nutrition_log WHERE user_id = ?', [uid]
        );

        res.json({ dias, total: Number(total), page, totalPages: Math.ceil(Number(total) / limite) });
    } catch (err) {
        console.error('[nutricao/historico]', err.message);
        res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
});

router.get('/nutricao', requirePlano, async (req, res) => {
    const uid = req.session.user.id;
    let imc = null;
    let metas = { kcal: 2000, proteina: 120, carbs: 250, gordura: 65, fibra: 25, agua: 2500, calculado: false };
    let registrosHoje = [], aderenciaSemanal = [];
    let objetivoAtual = null;

    try {
        const [imcRows] = await db.execute(
            'SELECT * FROM imc_profile WHERE user_id = ? ORDER BY id DESC LIMIT 1', [uid]
        );
        imc = imcRows[0] || null;
    } catch (err) { console.error('[nutricao/imc]', err); }

    try {
        const [[userRow]] = await db.execute(
            'SELECT nutricao_objetivo FROM `user` WHERE id = ?', [uid]
        );
        objetivoAtual = userRow?.nutricao_objetivo || null;
    } catch (_) {}

    const objOverride = objetivoAtual === 'cutting' ? 'cutting'
        : objetivoAtual === 'bulking' ? 'bulking'
        : objetivoAtual === 'manutencao' ? 'manutencao'
        : null;
    const imcComObjetivo = imc ? { ...imc, objetivo: objOverride || imc.objetivo || '' } : null;
    if (imcComObjetivo) metas = calcularMetas(imcComObjetivo);

    try {
        const dataHoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        const [rows] = await db.execute(
            `SELECT * FROM nutrition_log
             WHERE user_id = ? AND data = ? AND refeicao != 'agua'
             ORDER BY refeicao_tipo ASC, registrado_em ASC`,
            [uid, dataHoje]
        );
        for (const r of rows) {
            const [itens] = await db.execute(
                `SELECT id, alimento_nome AS nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g, fonte
                 FROM nutrition_item WHERE log_id = ?`,
                [r.id]
            );
            r.itens = itens;
        }
        registrosHoje = rows;
    } catch (err) { console.error('[nutricao/logs]', err); }

    try {
        [aderenciaSemanal] = await db.execute(
            `SELECT
                d.data,
                COALESCE(SUM(n.kcal), 0)       AS total_kcal,
                COALESCE(SUM(n.proteina_g), 0) AS total_prot
             FROM (
                SELECT CURDATE() - INTERVAL seq DAY AS data
                FROM (SELECT 0 seq UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
                      UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) s
             ) d
             LEFT JOIN nutrition_log n ON n.user_id = ? AND DATE(n.registrado_em) = d.data AND n.refeicao != 'agua'
             GROUP BY d.data ORDER BY d.data ASC`,
            [uid]
        );
    } catch (err) { console.error('[nutricao/aderencia]', err); }

    const totaisHoje = registrosHoje.reduce((acc, r) => ({
        kcal:     acc.kcal     + (Number(r.kcal)       || 0),
        proteina: acc.proteina + (Number(r.proteina_g) || 0),
        carbs:    acc.carbs    + (Number(r.carbs_g)    || 0),
        gordura:  acc.gordura  + (Number(r.gordura_g)  || 0),
        fibra:    acc.fibra    + (Number(r.fibra_g)    || 0),
    }), { kcal: 0, proteina: 0, carbs: 0, gordura: 0, fibra: 0 });

    const obj = objOverride || (imc?.objetivo || '').toLowerCase();
    let objetivoLabel = 'Manutenção';
    if (obj === 'cutting' || obj.includes('perder') || obj.includes('emagrecer') || obj.includes('cutting') || obj.includes('definir')) objetivoLabel = 'Cutting';
    else if (obj === 'bulking' || obj.includes('ganhar') || obj.includes('massa') || obj.includes('bulking') || obj.includes('hipertrofia')) objetivoLabel = 'Bulking';

    res.render('pages/nutricao', {
        user: req.session.user,
        imc,
        metas,
        registrosHoje,
        totaisHoje,
        aderenciaSemanal,
        objetivoLabel,
        objetivoAtual: objetivoAtual || 'manutencao',
        seo: { title: 'Nutrição — FitCrew', canonical: '/nutricao', robots: 'noindex, nofollow', description: 'Acompanhe sua nutrição diária no FitCrew.' },
    });
});

router.post('/api/nutricao/objetivo', requirePlano, async (req, res) => {
    const uid = req.session.user.id;
    const { objetivo } = req.body;
    const valid = ['cutting', 'manutencao', 'bulking'];
    if (!valid.includes(objetivo)) return res.status(400).json({ erro: 'Objetivo inválido.' });
    try {
        await db.execute('UPDATE `user` SET nutricao_objetivo = ? WHERE id = ?', [objetivo, uid]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[api/nutricao/objetivo]', err);
        res.status(500).json({ erro: 'Erro ao salvar objetivo.' });
    }
});

router.post('/api/nutricao/registrar', requirePlano, async (req, res) => {
    const uid = req.session.user.id;
    const { refeicao, refeicao_tipo, kcal, proteina_g, carbs_g, gordura_g, fibra_g, foto_url, data: dataCliente, horario: horarioCliente } = req.body;

    if (!refeicao || kcal === undefined || kcal === null || kcal === '') {
        return res.status(400).json({ erro: 'Nome da refeição e calorias são obrigatórios.' });
    }

    const tiposValidos = ['cafe', 'almoco', 'jantar', 'lanche', 'outro'];
    const tipo = tiposValidos.includes(refeicao_tipo) ? refeicao_tipo : 'outro';

    try {
        const [result] = await db.execute(
            `INSERT INTO nutrition_log (user_id, refeicao, refeicao_tipo, registrado_em, kcal, proteina_g, carbs_g, gordura_g, fibra_g, foto_url, horario)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [uid, String(refeicao).trim().slice(0, 255), tipo,
             dataCliente && horarioCliente ? `${dataCliente} ${horarioCliente}` : null,
             Math.round(Number(kcal) || 0),
             Number(proteina_g) || 0, Number(carbs_g) || 0,
             Number(gordura_g) || 0, Number(fibra_g) || 0,
             foto_url || null,
             horarioCliente || null]
        );
        const [[novoLog]] = await db.execute('SELECT * FROM nutrition_log WHERE id = ?', [result.insertId]);
        res.json({ ok: true, log: novoLog });
    } catch (err) {
        console.error('[api/nutricao/registrar]', err);
        res.status(500).json({ erro: 'Erro ao registrar alimento.' });
    }
});

router.post('/api/nutricao/foto', requirePlano, fotoNutricaoUpload.single('foto'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhuma foto enviada.' });

    const fotoUrl = req.file.path || req.file.secure_url;
    const fallback = { refeicao: 'Refeição', kcal: 300, proteina_g: 20, carbs_g: 40, gordura_g: 10, fibra_g: 3, observacao: '' };
    const pesoG = Number(req.body?.peso_g) || 0;
    const pesoTexto = pesoG > 0
        ? `A porção pesa aproximadamente ${pesoG}g. Use este peso para calcular os macros proporcionalmente.`
        : 'Estime a porção visual.';

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Analise esta foto de refeição. ${pesoTexto}\nRetorne APENAS um JSON válido, sem markdown:\n{"refeicao":"nome identificado","kcal":número inteiro,"proteina_g":decimal,"carbs_g":decimal,"gordura_g":decimal,"fibra_g":decimal,"observacao":"nota breve"}\nSeja conservador e realista.`,
                        },
                        { type: 'image_url', image_url: { url: fotoUrl } },
                    ],
                }],
                temperature: 0.3,
                max_tokens: 256,
            }),
        });

        const groqData = await response.json();
        const raw = groqData.choices?.[0]?.message?.content?.trim() || '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let analise;
        try { analise = JSON.parse(cleaned); } catch { analise = fallback; }

        res.json({ ok: true, fotoUrl, analise });
    } catch (err) {
        console.error('[api/nutricao/foto]', err);
        res.json({ ok: true, fotoUrl, analise: fallback });
    }
});

router.delete('/api/nutricao/:id', requirePlano, async (req, res) => {
    const uid = req.session.user.id;
    try {
        const [result] = await db.execute(
            'DELETE FROM nutrition_log WHERE id = ? AND user_id = ?',
            [req.params.id, uid]
        );
        if (result.affectedRows === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[api/nutricao/delete]', err);
        res.status(500).json({ erro: 'Erro ao excluir registro.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — login biométrico (pré-autenticação, sem requireAuth)
// ══════════════════════════════════════════════════════════════════

router.get('/api/webauthn/login/opcoes', async (req, res) => {
    const { identifier } = req.query;
    if (!identifier) return res.status(400).json({ erro: 'Identificador obrigatório.' });
    try {
        const user = await User.findActiveByIdentifier(identifier.trim());
        if (!user?.webauthn_enabled || !user?.webauthn_credential_id) {
            return res.status(400).json({ erro: 'Biometria não cadastrada para este usuário.' });
        }
        const opcoes = await webauthn.gerarOpcoesAutenticacao(user);
        req.session.webauthnChallenge     = opcoes.challenge;
        req.session.webauthnLoginUserId   = user.id;
        res.json(opcoes);
    } catch (err) {
        console.error('[webauthn/login/opcoes]', err.message);
        res.status(500).json({ erro: 'Erro ao gerar opções de login.' });
    }
});

router.post('/api/webauthn/login/verificar', async (req, res) => {
    const expectedChallenge = req.session.webauthnChallenge;
    const userId            = req.session.webauthnLoginUserId;
    if (!expectedChallenge || !userId) return res.status(400).json({ erro: 'Sessão expirada. Tente novamente.' });

    try {
        const [[userRow]] = await db.execute(
            'SELECT * FROM user WHERE id=? AND webauthn_enabled=1 AND status IN (\'ativo\',\'pendente_exclusao\')',
            [userId]
        );
        if (!userRow) return res.status(400).json({ erro: 'Usuário não encontrado.' });

        const verificacao = await webauthn.verificarAutenticacao(
            req.body,
            expectedChallenge,
            userRow.webauthn_public_key,
            userRow.webauthn_counter,
        );
        if (!verificacao.verified) return res.status(400).json({ erro: 'Autenticação biométrica falhou.' });

        await db.execute('UPDATE user SET webauthn_counter=? WHERE id=?',
            [verificacao.authenticationInfo.newCounter, userId]);

        req.session.webauthnChallenge   = null;
        req.session.webauthnLoginUserId = null;

        const [plano, imcRow, avalRow] = await Promise.all([
            User.getActivePlan(userRow.id),
            ImcProfile.findLatestByUser(userRow.id),
            BodyPhoto.findLatestByUser(userRow.id),
        ]);

        const imcData = imcRow ? {
            peso: imcRow.peso, altura: imcRow.altura, imcValor: imcRow.imc_valor,
            idade: imcRow.idade, sexo: imcRow.sexo, objetivo: imcRow.objetivo,
            experiencia: imcRow.experiencia, diasSemana: imcRow.dias_semana,
            tempoPorSessao: imcRow.tempo_por_sessao, localTreino: imcRow.local_treino,
            lesoes: safeJson(imcRow.lesoes, []),
            restricoesAlimentares: safeJson(imcRow.restricoes_alimentares, []),
            suplementacao: safeJson(imcRow.suplementacao, []),
            hidratacao: imcRow.hidratacao, seletividade: imcRow.seletividade,
            alimentosSeletividade: imcRow.alimentos_seletividade,
        } : null;

        const avalRaw  = avalRow ? safeJson(avalRow.analise_raw, null) : null;
        const avalData = avalRaw ? { ...avalRaw, data: new Date(avalRow.created_at).toLocaleDateString('pt-BR') } : null;

        const diasRestantesExclusao = (userRow.status === 'pendente_exclusao' && userRow.deletion_scheduled_at)
            ? Math.ceil((new Date(userRow.deletion_scheduled_at) - Date.now()) / 86400000)
            : null;

        req.session.user = {
            id:                         userRow.id,
            nome:                       userRow.nome,
            email:                      userRow.email,
            cpf:                        userRow.cpf,
            plano:                      plano?.nome  || null,
            planoId:                    plano?.id    || null,
            planoSlug:                  plano?.slug  || null,
            profile_photo:              userRow.profile_photo || null,
            status:                     userRow.status,
            deletion_scheduled_at:      userRow.deletion_scheduled_at || null,
            diasRestantesExclusao,
            webauthn_enabled:           userRow.webauthn_enabled || 0,
            last_imc_update:            userRow.last_imc_update  || null,
            last_avaliacao_update:      userRow.last_avaliacao_update || null,
            notification_interval_days: userRow.notification_interval_days || 7,
            imc:                        imcData,
            avaliacaoCorporal:          avalData,
        };

        broadcast('user_online', { id: userRow.id, nome: userRow.nome, email: userRow.email });

        req.session.save(err => {
            if (err) return res.status(500).json({ erro: 'Erro ao salvar sessão.' });
            res.json({ ok: true, redirect: '/area-aluno' });
        });
    } catch (err) {
        console.error('[webauthn/login/verificar]', err.message);
        res.status(500).json({ erro: 'Erro ao verificar login biométrico: ' + err.message });
    }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — registro de biometria
// ══════════════════════════════════════════════════════════════════

router.get('/api/webauthn/registro/opcoes', requireAuth, async (req, res) => {
    try {
        const opcoes = await webauthn.gerarOpcoesRegistro(req.session.user);
        req.session.webauthnChallenge = opcoes.challenge;
        res.json(opcoes);
    } catch (err) {
        console.error('[webauthn/registro/opcoes]', err.message);
        res.status(500).json({ erro: 'Erro ao gerar opções de registro.' });
    }
});

router.post('/api/webauthn/registro/verificar', requireAuth, async (req, res) => {
    try {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) return res.status(400).json({ erro: 'Challenge expirado.' });

        const verificacao = await webauthn.verificarRegistro(req.body, expectedChallenge);
        if (!verificacao.verified) return res.status(400).json({ erro: 'Verificação falhou.' });

        // v9+: registrationInfo.credential.{id, publicKey, counter}
        const { id: credentialID, publicKey: credentialPublicKey, counter } = verificacao.registrationInfo.credential;

        await db.execute(
            'UPDATE user SET webauthn_credential_id=?, webauthn_public_key=?, webauthn_counter=?, webauthn_enabled=1 WHERE id=?',
            [
                credentialID,                                          // base64url string
                Buffer.from(credentialPublicKey).toString('base64'),   // standard base64
                counter,
                req.session.user.id,
            ]
        );

        req.session.webauthnChallenge    = null;
        req.session.user.webauthn_enabled = 1;
        res.json({ ok: true });
    } catch (err) {
        console.error('[webauthn/registro/verificar]', err.message);
        res.status(500).json({ erro: 'Erro ao verificar registro: ' + err.message });
    }
});

router.post('/api/webauthn/registro/remover', requireAuth, async (req, res) => {
    try {
        await db.execute(
            'UPDATE user SET webauthn_enabled=0, webauthn_credential_id=NULL, webauthn_public_key=NULL, webauthn_counter=0 WHERE id=?',
            [req.session.user.id]
        );
        req.session.user.webauthn_enabled = 0;
        res.json({ ok: true });
    } catch (err) {
        console.error('[webauthn/registro/remover]', err.message);
        res.status(500).json({ erro: 'Erro ao remover biometria.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — autenticação por biometria
// ══════════════════════════════════════════════════════════════════

router.get('/api/webauthn/auth/opcoes', requireAuth, async (req, res) => {
    try {
        const [[userRow]] = await db.execute(
            'SELECT webauthn_credential_id, webauthn_enabled FROM user WHERE id=?',
            [req.session.user.id]
        );
        if (!userRow?.webauthn_enabled) return res.status(400).json({ erro: 'Biometria não cadastrada.' });
        const opcoes = await webauthn.gerarOpcoesAutenticacao(userRow);
        req.session.webauthnChallenge = opcoes.challenge;
        res.json(opcoes);
    } catch (err) {
        console.error('[webauthn/auth/opcoes]', err.message);
        res.status(500).json({ erro: 'Erro ao gerar opções de autenticação.' });
    }
});

router.post('/api/webauthn/auth/verificar', requireAuth, async (req, res) => {
    try {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) return res.status(400).json({ erro: 'Challenge expirado.' });

        const [[userRow]] = await db.execute(
            'SELECT webauthn_public_key, webauthn_counter FROM user WHERE id=?',
            [req.session.user.id]
        );

        const verificacao = await webauthn.verificarAutenticacao(
            req.body,
            expectedChallenge,
            userRow.webauthn_public_key,
            userRow.webauthn_counter,
        );
        if (!verificacao.verified) return res.status(400).json({ erro: 'Autenticação falhou.' });

        await db.execute(
            'UPDATE user SET webauthn_counter=? WHERE id=?',
            [verificacao.authenticationInfo.newCounter, req.session.user.id]
        );

        req.session.webauthnChallenge = null;
        res.json({ ok: true, verificado: true });
    } catch (err) {
        console.error('[webauthn/auth/verificar]', err.message);
        res.status(500).json({ erro: 'Erro ao verificar autenticação.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// CONTA — exclusão com soft delete
// ══════════════════════════════════════════════════════════════════

router.get('/api/conta/info-exclusao', requireAuth, async (req, res) => {
    try {
        const plano = await User.getActivePlan(req.session.user.id);
        res.json({
            temPlanoAtivo: !!plano,
            planoNome:     plano?.nome   || null,
            planoExpira:   plano?.expira_em || null,
        });
    } catch (err) {
        console.error('[conta/info-exclusao]', err.message);
        res.status(500).json({ erro: 'Erro ao buscar informações.' });
    }
});

router.post('/api/conta/solicitar-exclusao', requireAuth, async (req, res) => {
    const uid = req.session.user.id;
    const { senha, webauthn_verificado } = req.body;

    try {
        if (!webauthn_verificado) {
            if (!senha) return res.status(400).json({ erro: 'Confirmação obrigatória.' });
            const [[userRow]] = await db.execute('SELECT senha_hash FROM user WHERE id=?', [uid]);
            const ok = await bcrypt.compare(senha, userRow.senha_hash);
            if (!ok) return res.status(401).json({ erro: 'Senha incorreta.' });
        }

        const deletion_scheduled_at = new Date();
        deletion_scheduled_at.setDate(deletion_scheduled_at.getDate() + 30);

        await db.execute(
            "UPDATE user SET status='pendente_exclusao', deletion_scheduled_at=? WHERE id=?",
            [deletion_scheduled_at, uid]
        );

        req.session.user.status                = 'pendente_exclusao';
        req.session.user.deletion_scheduled_at = deletion_scheduled_at;
        res.json({ ok: true, deletion_scheduled_at });
    } catch (err) {
        console.error('[conta/solicitar-exclusao]', err.message);
        res.status(500).json({ erro: 'Erro ao agendar exclusão.' });
    }
});

router.post('/api/conta/cancelar-exclusao', requireAuth, async (req, res) => {
    try {
        await db.execute(
            "UPDATE user SET status='ativo', deletion_scheduled_at=NULL WHERE id=?",
            [req.session.user.id]
        );
        req.session.user.status                = 'ativo';
        req.session.user.deletion_scheduled_at = null;
        req.session.user.diasRestantesExclusao = null;
        res.json({ ok: true });
    } catch (err) {
        console.error('[conta/cancelar-exclusao]', err.message);
        res.status(500).json({ erro: 'Erro ao cancelar exclusão.' });
    }
});

// ====================
// TROCA DE IDIOMA
// ====================
router.get('/lang/:locale', (req, res) => {
    const locale = req.params.locale;
    if (['pt', 'en', 'es'].includes(locale)) {
        res.cookie('gymbros_lang', locale, { maxAge: 365 * 24 * 60 * 60 * 1000, path: '/', sameSite: 'Lax' });
        i18n.setLocale(req, locale);
    }
    const back = req.headers.referer || '/';
    res.redirect(back);
});

module.exports = router;
