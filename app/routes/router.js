// router.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const Fuse = require("fuse.js");
const { body, validationResult } = require("express-validator");
const { enviarBoleto } = require("../services/email");
const { gerarBoletoPDF } = require("../services/pdf");
const conquistas = require("../services/conquistas");
const { calcularMetas } = require("../services/nutricao");
const { searchAlimento } = require("../services/foodSearch");
const { GoogleGenAI } = require("@google/genai");
const webauthn = require("../services/webauthn");
const db = require("../config/db");
const User = require("../models/User");
const Plan = require("../models/Plan");
const Payment = require("../models/Payment");
const ImcProfile = require("../models/ImcProfile");
const BodyPhoto = require("../models/BodyPhoto");
const i18n = require("../config/i18n");
const {
  broadcast,
  onlineUsers,
  addTicketClient,
  broadcastTicket,
  emitToUser,
  registerUserSSE,
  unregisterUserSSE,
} = require("../events");
const { criarNotificacao } = require("../services/notificacoes");
const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const requirePlanLevel = require("../middleware/requirePlanLevel");
const { limiterLogin, limiterUpload, limiterSSE, limiterBusca } = require("../middleware/rateLimits");
const { uploadPost } = require("../middleware/uploadPost");
const { uploadChat } = require("../middleware/uploadChat");
const { registrarMidiaAprovada } = require("../services/chatWs");
const {
  moderarImagem,
  moderarVideo,
  moderarTexto,
} = require("../services/moderacao");
const { encryptCpf, decryptCpf, hmacCpf } = require("../services/cripto");
const {
  recalcularPontuacao,
  buscarPlacar,
  pushPlacar,
  atualizarGymSquadsUsuario,
} = require("../services/gymsquadPontuacao");

function safeJson(str, fallback) {
  try {
    return JSON.parse(str || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

// Migrations sequenciais — uma conexão só, evita max_user_connections no Clever Cloud
(async () => {
  // 1. Colunas de tradução de exercícios
  for (const sql of [
    "ALTER TABLE exercises ADD COLUMN name_pt VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE exercises ADD COLUMN name_es VARCHAR(255) DEFAULT NULL",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] alter exercises:", err.message);
    }
  }

  // 2. Colunas de perfil de usuário
  for (const sql of [
    "ALTER TABLE user ADD COLUMN instagram_username VARCHAR(60) DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN username VARCHAR(30) DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN bio VARCHAR(150) DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN medalhas_destaque JSON DEFAULT NULL",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] alter user perfil:", err.message);
    }
  }
  try {
    await db.execute("CREATE UNIQUE INDEX idx_username ON user(username)");
  } catch (err) {
    if (err.errno !== 1061)
      console.error("[migration] idx_username:", err.message);
  }

  // 3. Colunas de soft delete e WebAuthn (F16)
  for (const sql of [
    "ALTER TABLE user ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN deletion_scheduled_at TIMESTAMP NULL DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN webauthn_credential_id VARCHAR(500) NULL DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN webauthn_public_key TEXT NULL DEFAULT NULL",
    "ALTER TABLE user ADD COLUMN webauthn_counter INT UNSIGNED NOT NULL DEFAULT 0",
    "ALTER TABLE user ADD COLUMN webauthn_enabled TINYINT(1) NOT NULL DEFAULT 0",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] alter user F16:", err.message);
    }
  }
  try {
    await db.execute(
      "ALTER TABLE user MODIFY COLUMN status ENUM('ativo','inativo','pendente_exclusao') NOT NULL DEFAULT 'ativo'",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] status enum:", err.message);
  }

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
  } catch (err) {
    console.error("[migration] treino_checkins:", err.message);
  }

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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] workout_plans:", err.message);
  }
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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] diet_plans:", err.message);
  }

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
  } catch (err) {
    console.error("[migration] treino_sessao:", err.message);
  }

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
  } catch (err) {
    console.error("[migration] conquistas:", err.message);
  }

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
  } catch (err) {
    console.error("[migration] nutrition_log:", err.message);
  }

  // 8. Colunas extras de nutrition_log
  for (const sql of [
    "ALTER TABLE nutrition_log ADD COLUMN proteina_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER kcal",
    "ALTER TABLE nutrition_log ADD COLUMN carbs_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER proteina_g",
    "ALTER TABLE nutrition_log ADD COLUMN gordura_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER carbs_g",
    "ALTER TABLE nutrition_log ADD COLUMN fibra_g DECIMAL(6,1) NOT NULL DEFAULT 0 AFTER gordura_g",
    "ALTER TABLE nutrition_log ADD COLUMN refeicao_tipo ENUM('cafe','almoco','jantar','lanche','outro') NOT NULL DEFAULT 'outro' AFTER refeicao",
    "ALTER TABLE nutrition_log ADD COLUMN foto_url VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE nutrition_log ADD COLUMN data DATE GENERATED ALWAYS AS (DATE(registrado_em)) STORED",
    "ALTER TABLE nutrition_log ADD INDEX idx_nl_user_data2 (user_id, data)",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060 && err.errno !== 1061 && err.errno !== 1054)
        console.error("[migration] nutrition_log extra:", err.message);
    }
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
        "ALTER TABLE `user` ADD COLUMN nutricao_objetivo ENUM('cutting','manutencao','bulking') DEFAULT NULL",
      );
    }
  } catch (err) {
    console.error("[migration] nutricao_objetivo:", err.message);
  }

  // 10. Coluna horario em nutrition_log
  try {
    await db.execute(
      "ALTER TABLE nutrition_log ADD COLUMN horario TIME DEFAULT NULL",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] nutrition_log horario:", err.message);
  }

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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] nutrition_item:", err.message);
  }

  // 12. Adiciona valor 'taco' ao ENUM fonte de nutrition_item
  try {
    await db.execute(
      "ALTER TABLE nutrition_item MODIFY COLUMN fonte ENUM('usda','openfoodfacts','ia','manual','taco') NOT NULL DEFAULT 'manual'",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] nutrition_item fonte:", err.message);
  }

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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] F6 equipamento tables:", err.message);
  }

  // 14. Fix: exercise_id em equipamento_exercicio deve ser VARCHAR(50) para referenciar exercises.id
  try {
    await db.execute(
      "ALTER TABLE equipamento_exercicio DROP FOREIGN KEY fk_eqex_ex",
    );
  } catch (err) {
    if (err.errno !== 1091) console.error("[F6 drop fk_eqex_ex]", err.message);
  }
  try {
    await db.execute(
      "ALTER TABLE equipamento_exercicio MODIFY COLUMN exercise_id VARCHAR(50) NOT NULL",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[F6 alter equipamento_exercicio]", err.message);
  }
  try {
    await db.execute(
      "ALTER TABLE equipamento_exercicio ADD CONSTRAINT fk_eqex_ex FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE",
    );
  } catch (err) {
    if (err.errno !== 1826) console.error("[F6 add fk_eqex_ex]", err.message);
  }

  // 15. context_summary em ai_session
  try {
    await db.execute(
      "ALTER TABLE ai_session ADD COLUMN context_summary TEXT NULL",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] ai_session context_summary:", err.message);
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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] push_subscriptions:", err.message);
  }

  // 17. Remover plano Starter e atualizar preços
  try {
    const [[starterRow]] = await db.execute(
      "SELECT id FROM plan WHERE slug='starter' LIMIT 1",
    );
    if (starterRow) {
      const [[gymbroRow]] = await db.execute(
        "SELECT id FROM plan WHERE slug='gymbro' LIMIT 1",
      );
      if (gymbroRow) {
        await db.execute("UPDATE user_plan SET plan_id=? WHERE plan_id=?", [
          gymbroRow.id,
          starterRow.id,
        ]);
        await db.execute("UPDATE payment   SET plan_id=? WHERE plan_id=?", [
          gymbroRow.id,
          starterRow.id,
        ]);
      }
      await db.execute("DELETE FROM plan WHERE slug='starter'");
    }
    await db.execute(
      "UPDATE plan SET preco=29.90 WHERE slug='gymbro' AND preco=85.60",
    );
    await db.execute(
      "UPDATE plan SET preco=59.90 WHERE slug='black' AND preco=145.90",
    );
  } catch (err) {
    console.error("[migration] planos_update:", err.message);
  }

  // 18. Atualizar benefícios do GymBro (remover referência ao Starter)
  try {
    const gymbroBen = JSON.stringify([
      "Treinos manuais + execução com GIFs",
      "IA treinadora personalizada",
      "Plano de treino gerado por IA",
      "Plano de dieta gerado por IA",
      "Histórico completo de conversas IA",
    ]);
    await db.execute(
      "UPDATE plan SET beneficios=? WHERE slug='gymbro' AND JSON_SEARCH(beneficios, 'one', 'Tudo do Starter') IS NOT NULL",
      [gymbroBen],
    );
  } catch (err) {
    console.error("[migration] gymbro_beneficios:", err.message);
  }

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
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] ticket:", err.message);
  }

  try {
    await db.execute(
      "ALTER TABLE ticket ADD COLUMN tipo VARCHAR(100) NOT NULL DEFAULT 'Outro' AFTER mensagem",
    );
    await db.execute("ALTER TABLE ticket DROP COLUMN categoria");
  } catch (err) {
    if (err.errno !== 1060 && err.errno !== 1091)
      console.error("[migration] ticket alter:", err.message);
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
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] ticket_mensagem:", err.message);
  }

  try {
    await db.execute(
      "ALTER TABLE ticket MODIFY COLUMN status ENUM('aberto','em_atendimento','resolvido','fechado') NOT NULL DEFAULT 'aberto'",
    );
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] alter ticket status:", err.message);
  }

  // F1 — colunas de perfil social e gamificação
  for (const sql of [
    "ALTER TABLE user ADD COLUMN qr_token      VARCHAR(64) UNIQUE NULL",
    "ALTER TABLE user ADD COLUMN perfil_publico TINYINT(1) NOT NULL DEFAULT 1",
    "ALTER TABLE user ADD COLUMN xp_total      INT NOT NULL DEFAULT 0",
    "ALTER TABLE user ADD COLUMN nivel         INT NOT NULL DEFAULT 1",
    "ALTER TABLE user ADD COLUMN streak_atual  INT NOT NULL DEFAULT 0",
    "ALTER TABLE user ADD COLUMN streak_maximo INT NOT NULL DEFAULT 0",
    "ALTER TABLE user ADD COLUMN status_conta  ENUM('ativo','banido','suspenso') NOT NULL DEFAULT 'ativo'",
    "ALTER TABLE user ADD COLUMN first_login   TINYINT(1) NOT NULL DEFAULT 1",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] F1 user cols:", err.message);
    }
  }
  try {
    await db.execute(`
            UPDATE user
            SET qr_token = HEX(UNHEX(MD5(CONCAT(id, email, RAND()))))
            WHERE qr_token IS NULL
        `);
    console.log("[migration] qr_token gerado para usuários existentes");
  } catch (err) {
    console.error("[migration] qr_token update:", err.message);
  }

  // F2 — visibilidade nos planos de treino
  try {
    await db.execute(
      "ALTER TABLE workout_plans ADD COLUMN visibilidade ENUM('privado','publico') NOT NULL DEFAULT 'privado'",
    );
    console.log("[migration] workout_plans.visibilidade adicionada");
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] workout_plans visibilidade:", err.message);
  }

  // F2 fix — mudar default para 'publico' e publicar treinos já existentes
  try {
    await db.execute(
      "ALTER TABLE workout_plans MODIFY COLUMN visibilidade ENUM('privado','publico') NOT NULL DEFAULT 'publico'",
    );
    await db.execute(
      "UPDATE workout_plans SET visibilidade = 'publico' WHERE visibilidade = 'privado'",
    );
    console.log(
      "[migration] workout_plans.visibilidade default -> publico, treinos existentes publicados",
    );
  } catch (err) {
    console.error(
      "[migration] workout_plans visibilidade default:",
      err.message,
    );
  }

  // F4 — tabela de amizades
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS friendship (
                id INT AUTO_INCREMENT PRIMARY KEY,
                solicitante_id INT NOT NULL,
                destinatario_id INT NOT NULL,
                status ENUM('pendente','aceito','recusado','bloqueado') NOT NULL DEFAULT 'pendente',
                criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_friendship (solicitante_id, destinatario_id),
                KEY idx_friendship_dest (destinatario_id),
                KEY idx_friendship_status (status)
            )
        `);
    console.log("[migration] friendship table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] friendship:", err.message);
  }

  // F9 — tabela de notificações sociais
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS notificacao_social (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT NOT NULL,
                tipo VARCHAR(50) NOT NULL,
                titulo VARCHAR(255) NOT NULL,
                mensagem TEXT,
                lida TINYINT(1) NOT NULL DEFAULT 0,
                dados_extras JSON,
                criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_ns_usuario (usuario_id),
                KEY idx_ns_lida (lida)
            )
        `);
    console.log("[migration] notificacao_social table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] notificacao_social:", err.message);
  }

  // F5 — tabelas de posts (feed)
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS post (
                id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id           INT UNSIGNED NOT NULL,
                legenda           VARCHAR(2200) NULL,
                tipo              ENUM('texto','foto','video','carrossel') NOT NULL DEFAULT 'texto',
                status            ENUM('ativo','removido','em_revisao') NOT NULL DEFAULT 'ativo',
                moderado          TINYINT(1) NOT NULL DEFAULT 0,
                motivo_moderacao  VARCHAR(50) NULL,
                visibilidade      ENUM('publico','amigos','privado') NOT NULL DEFAULT 'amigos',
                total_reacoes     INT NOT NULL DEFAULT 0,
                total_comentarios INT NOT NULL DEFAULT 0,
                created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_post_user (user_id),
                KEY idx_post_status (status),
                KEY idx_post_created (created_at),
                CONSTRAINT fk_post_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] post table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] post:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS post_midia (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                post_id    INT UNSIGNED NOT NULL,
                url        VARCHAR(500) NOT NULL,
                public_id  VARCHAR(200) NULL,
                tipo       ENUM('foto','video') NOT NULL,
                ordem      TINYINT NOT NULL DEFAULT 0,
                largura    INT NULL,
                altura     INT NULL,
                PRIMARY KEY (id),
                KEY idx_pm_post (post_id),
                CONSTRAINT fk_pm_post FOREIGN KEY (post_id) REFERENCES post(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] post_midia table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] post_midia:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS denuncia (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                denunciante  INT UNSIGNED NOT NULL,
                tipo_alvo    ENUM('post','comentario','usuario') NOT NULL DEFAULT 'post',
                alvo_id      INT UNSIGNED NOT NULL,
                motivo       ENUM('obsceno','spam','violencia','fake','outro') NOT NULL DEFAULT 'outro',
                descricao    VARCHAR(500) NULL,
                criado_em    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_denuncia_alvo (tipo_alvo, alvo_id),
                KEY idx_denuncia_denunciante (denunciante)
            )
        `);
    console.log("[migration] denuncia table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] denuncia:", err.message);
  }

  // F6 — tabelas de comentários e reações
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS comentario (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                post_id    INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                parent_id  INT UNSIGNED NULL,
                texto      VARCHAR(1000) NOT NULL,
                mencoes    JSON NULL,
                status     ENUM('ativo','removido') NOT NULL DEFAULT 'ativo',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_com_post (post_id),
                KEY idx_com_user (user_id),
                CONSTRAINT fk_com_post   FOREIGN KEY (post_id)   REFERENCES post(id) ON DELETE CASCADE,
                CONSTRAINT fk_com_user   FOREIGN KEY (user_id)   REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_com_parent FOREIGN KEY (parent_id) REFERENCES comentario(id) ON DELETE SET NULL
            )
        `);
    console.log("[migration] comentario table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] comentario:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS reacao (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                post_id    INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                tipo       ENUM('fogo','musculo','surpresa','parabens','forca') NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_reacao (post_id, user_id),
                CONSTRAINT fk_reacao_post FOREIGN KEY (post_id) REFERENCES post(id) ON DELETE CASCADE,
                CONSTRAINT fk_reacao_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] reacao table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] reacao:", err.message);
  }

  // F7 — tabela de eventos do feed (check-in, treino, conquista)
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS feed_event (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id    INT UNSIGNED NOT NULL,
                tipo       ENUM('checkin','treino','conquista') NOT NULL,
                ref_id     INT UNSIGNED NULL,
                ref_tipo   VARCHAR(30) NULL,
                payload    JSON NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_fe_user (user_id),
                KEY idx_fe_created (created_at),
                CONSTRAINT fk_fe_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] feed_event table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] feed_event:", err.message);
  }

  // F8 — tabelas de stories (24h)
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS story (
                id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id     INT UNSIGNED NOT NULL,
                tipo        ENUM('foto','video','texto') NOT NULL,
                url         VARCHAR(500) NULL,
                public_id   VARCHAR(200) NULL,
                texto       VARCHAR(500) NULL,
                cor_fundo   VARCHAR(20) NULL DEFAULT '#1a1a1a',
                expira_em   DATETIME NOT NULL,
                views       INT NOT NULL DEFAULT 0,
                created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_story_user (user_id),
                KEY idx_story_expira (expira_em),
                CONSTRAINT fk_story_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] story table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] story:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS story_view (
                story_id   INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                viewed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (story_id, user_id),
                CONSTRAINT fk_sv_story FOREIGN KEY (story_id) REFERENCES story(id) ON DELETE CASCADE,
                CONSTRAINT fk_sv_user  FOREIGN KEY (user_id)  REFERENCES user(id) ON DELETE CASCADE
            )
        `);
    console.log("[migration] story_view table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] story_view:", err.message);
  }

  // F12 — Treinos sociais: modo de colaboração + membros do treino
  try {
    await db.execute(
      "ALTER TABLE workout_plans ADD COLUMN modo_colaboracao ENUM('readonly','editavel') NOT NULL DEFAULT 'readonly' AFTER visibilidade",
    );
    console.log("[migration] workout_plans.modo_colaboracao adicionada");
  } catch (err) {
    if (err.errno !== 1060)
      console.error(
        "[migration] workout_plans modo_colaboracao:",
        err.message,
      );
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS workout_membros (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                plan_id    INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                status     ENUM('pendente','aceito','recusado') NOT NULL DEFAULT 'pendente',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_workout_membro (plan_id, user_id),
                INDEX idx_wm_user (user_id),
                CONSTRAINT fk_wm_plan FOREIGN KEY (plan_id) REFERENCES workout_plans(id) ON DELETE CASCADE,
                CONSTRAINT fk_wm_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] workout_membros table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] workout_membros:", err.message);
  }

  // F13 — Agenda com amigos: eventos de treino (individual/grupo) + participantes
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS treino_evento (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                criador_id      INT UNSIGNED NOT NULL,
                nome            VARCHAR(200) NOT NULL,
                descricao       VARCHAR(500) NULL,
                data_hora       DATETIME NOT NULL,
                workout_plan_id INT UNSIGNED NULL,
                tipo            ENUM('individual','grupo') NOT NULL DEFAULT 'individual',
                status          ENUM('ativo','cancelado') NOT NULL DEFAULT 'ativo',
                created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_te_criador (criador_id),
                INDEX idx_te_data (data_hora),
                CONSTRAINT fk_te_criador FOREIGN KEY (criador_id) REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_te_plan FOREIGN KEY (workout_plan_id) REFERENCES workout_plans(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
    console.log("[migration] treino_evento table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] treino_evento:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS treino_evento_participante (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                evento_id  INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                status     ENUM('pendente','confirmado','talvez','recusado') NOT NULL DEFAULT 'pendente',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_tep (evento_id, user_id),
                INDEX idx_tep_user (user_id),
                CONSTRAINT fk_tep_evento FOREIGN KEY (evento_id) REFERENCES treino_evento(id) ON DELETE CASCADE,
                CONSTRAINT fk_tep_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] treino_evento_participante table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] treino_evento_participante:", err.message);
  }

  // F14 — Moderação: role, suspensão/banimento, apelações, log de ações
  // OBS: user.role não existia antes — é ADD, não MODIFY.
  try {
    await db.execute(
      "ALTER TABLE user ADD COLUMN role ENUM('aluno','gym_admin','moderador','admin') NOT NULL DEFAULT 'aluno' AFTER status_conta",
    );
    console.log("[migration] user.role adicionada");
  } catch (err) {
    if (err.errno !== 1060) console.error("[migration] user.role:", err.message);
  }
  for (const sql of [
    "ALTER TABLE user ADD COLUMN suspenso_ate DATETIME NULL AFTER role",
    "ALTER TABLE user ADD COLUMN motivo_suspensao VARCHAR(500) NULL AFTER suspenso_ate",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] user suspensao cols:", err.message);
    }
  }

  // denuncia não tinha coluna de status nem 'story' como alvo válido — F5 só
  // previa post/comentario/usuario. Necessário pro painel de moderação (F14).
  try {
    await db.execute(
      "ALTER TABLE denuncia ADD COLUMN status ENUM('pendente','resolvida','ignorada') NOT NULL DEFAULT 'pendente' AFTER descricao",
    );
    console.log("[migration] denuncia.status adicionada");
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] denuncia.status:", err.message);
  }
  try {
    await db.execute(
      "ALTER TABLE denuncia MODIFY COLUMN tipo_alvo ENUM('post','comentario','story','usuario') NOT NULL DEFAULT 'post'",
    );
  } catch (err) {
    console.error("[migration] denuncia.tipo_alvo:", err.message);
  }

  // story não tinha coluna de status — sem ela, remoção por moderação não tem
  // como esconder o conteúdo (a expiração natural via cron não serve pra isso).
  try {
    await db.execute(
      "ALTER TABLE story ADD COLUMN status ENUM('ativo','removido') NOT NULL DEFAULT 'ativo' AFTER views",
    );
    console.log("[migration] story.status adicionada");
  } catch (err) {
    if (err.errno !== 1060)
      console.error("[migration] story.status:", err.message);
  }

  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS apelacao (
                id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id      INT UNSIGNED NOT NULL,
                tipo_acao    ENUM('suspensao','banimento') NOT NULL,
                mensagem     VARCHAR(1000) NOT NULL,
                status       ENUM('pendente','aceita','recusada') NOT NULL DEFAULT 'pendente',
                mod_id       INT UNSIGNED NULL,
                resposta_mod VARCHAR(500) NULL,
                created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_ap_user (user_id),
                INDEX idx_ap_status (status),
                CONSTRAINT fk_ap_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_ap_mod  FOREIGN KEY (mod_id)  REFERENCES user(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
    console.log("[migration] apelacao table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] apelacao:", err.message);
  }

  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS mod_acao (
                id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
                mod_id       INT UNSIGNED NOT NULL,
                alvo_user_id INT UNSIGNED NULL,
                alvo_tipo    ENUM('post','comentario','story','usuario') NOT NULL,
                alvo_id      INT UNSIGNED NULL,
                acao         ENUM('remover','avisar','suspender','banir','reativar','ignorar_denuncia') NOT NULL,
                motivo       VARCHAR(500) NULL,
                created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_ma_mod (mod_id),
                INDEX idx_ma_alvo_user (alvo_user_id),
                CONSTRAINT fk_ma_mod FOREIGN KEY (mod_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] mod_acao table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] mod_acao:", err.message);
  }

  // Chat — conversas 1:1 e grupos, membros, mensagens
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS chat_conversa (
                id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
                tipo        ENUM('individual','grupo') NOT NULL DEFAULT 'individual',
                nome        VARCHAR(100) NULL,
                foto        VARCHAR(500) NULL,
                criador_id  INT UNSIGNED NULL,
                created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_cc_updated (updated_at),
                CONSTRAINT fk_cc_criador FOREIGN KEY (criador_id) REFERENCES user(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
    console.log("[migration] chat_conversa table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] chat_conversa:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS chat_membro (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
                conversa_id    INT UNSIGNED NOT NULL,
                user_id        INT UNSIGNED NOT NULL,
                role           ENUM('membro','admin') NOT NULL DEFAULT 'membro',
                ultima_leitura DATETIME NULL,
                created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_cm (conversa_id, user_id),
                INDEX idx_cm_user (user_id),
                CONSTRAINT fk_cm_conversa FOREIGN KEY (conversa_id) REFERENCES chat_conversa(id) ON DELETE CASCADE,
                CONSTRAINT fk_cm_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] chat_membro table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] chat_membro:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS chat_mensagem (
                id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
                conversa_id INT UNSIGNED NOT NULL,
                user_id     INT UNSIGNED NOT NULL,
                tipo        ENUM('texto','foto','audio') NOT NULL DEFAULT 'texto',
                conteudo    TEXT NULL,
                public_id   VARCHAR(200) NULL,
                duracao     INT NULL,
                moderado    TINYINT(1) NOT NULL DEFAULT 0,
                status      ENUM('ativo','removido') NOT NULL DEFAULT 'ativo',
                created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_cm_conversa (conversa_id),
                INDEX idx_cm_user (user_id),
                INDEX idx_cm_created (created_at),
                CONSTRAINT fk_cmsg_conversa FOREIGN KEY (conversa_id) REFERENCES chat_conversa(id) ON DELETE CASCADE,
                CONSTRAINT fk_cmsg_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] chat_mensagem table OK");
  } catch (err) {
    if (err.errno !== 1050)
      console.error("[migration] chat_mensagem:", err.message);
  }

  // Criptografia de CPF (AES-256-GCM + HMAC-SHA256 pra busca)
  for (const sql of [
    "ALTER TABLE user ADD COLUMN cpf_enc  VARCHAR(200) NULL AFTER cpf",
    "ALTER TABLE user ADD COLUMN cpf_hmac VARCHAR(64)  NULL AFTER cpf_enc",
  ]) {
    try {
      await db.execute(sql);
    } catch (err) {
      if (err.errno !== 1060)
        console.error("[migration] alter user cpf_enc/cpf_hmac:", err.message);
    }
  }
  try {
    await db.execute("ALTER TABLE user ADD UNIQUE INDEX uq_cpf_hmac (cpf_hmac)");
  } catch (err) {
    if (err.errno !== 1061)
      console.error("[migration] uq_cpf_hmac:", err.message);
  }
  try {
    await db.execute("ALTER TABLE user MODIFY COLUMN cpf CHAR(11) NULL DEFAULT NULL");
  } catch (err) {
    console.error("[migration] cpf nullable:", err.message);
  }

  try {
    const [usersSemHmac] = await db.execute(
      "SELECT id, cpf FROM user WHERE cpf IS NOT NULL AND cpf_hmac IS NULL",
    );
    for (const u of usersSemHmac) {
      if (!u.cpf || u.cpf.startsWith("deleted_")) continue;
      const cpfLimpo = u.cpf.replace(/\D/g, "");
      if (cpfLimpo.length !== 11) continue;
      await db.execute("UPDATE user SET cpf_enc = ?, cpf_hmac = ? WHERE id = ?", [
        encryptCpf(cpfLimpo),
        hmacCpf(cpfLimpo),
        u.id,
      ]);
    }
    if (usersSemHmac.length > 0)
      console.log(
        `[migration] CPF encriptado para ${usersSemHmac.length} usuário(s) existente(s)`,
      );
  } catch (err) {
    console.error("[migration] CPF encryption backfill:", err.message);
  }

  // F18 — Renomeia GymRat -> GymSquad (tabelas e coluna FK)
  // Nomes antigos montados por array.join() de propósito: uma busca/troca
  // futura de "gymrat"->"gymsquad" no arquivo não deve apagar o nome de
  // origem que esta migration precisa pra funcionar em bases já existentes.
  for (const [oldName, newName] of [
    [["g", "y", "m", "r", "a", "t"].join(""), "gymsquad"],
    [["g", "y", "m", "r", "a", "t", "_membro"].join(""), "gymsquad_membro"],
    [["g", "y", "m", "r", "a", "t", "_post"].join(""), "gymsquad_post"],
    [["g", "y", "m", "r", "a", "t", "_convite"].join(""), "gymsquad_convite"],
    [["g", "y", "m", "r", "a", "t", "_distancia"].join(""), "gymsquad_distancia"],
  ]) {
    try {
      await db.execute(`RENAME TABLE ${oldName} TO ${newName}`);
      console.log(`[migration] renomeado ${oldName} -> ${newName}`);
    } catch (err) {
      if (err.errno !== 1146)
        console.error(`[migration] rename ${oldName}:`, err.message);
    }
  }
  for (const tabela of [
    "gymsquad_membro",
    "gymsquad_post",
    "gymsquad_convite",
    "gymsquad_distancia",
  ]) {
    try {
      const colunaAntiga = ["g", "y", "m", "r", "a", "t", "_id"].join("");
      await db.execute(
        `ALTER TABLE ${tabela} CHANGE COLUMN ${colunaAntiga} gymsquad_id INT UNSIGNED NOT NULL`,
      );
      console.log(`[migration] coluna renomeada em ${tabela}`);
    } catch (err) {
      if (err.errno !== 1054 && err.errno !== 1146)
        console.error(`[migration] rename coluna ${tabela}:`, err.message);
    }
  }

  // F17 — GymSquads (grupos de desafio)
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS gymsquad (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
                nome           VARCHAR(200) NOT NULL,
                descricao      VARCHAR(500) NULL,
                foto           VARCHAR(500) NULL,
                criador_id     INT UNSIGNED NOT NULL,
                tipo_desafio   ENUM('frequencia','carga','distancia','tempo','personalizado')
                               NOT NULL DEFAULT 'frequencia',
                descricao_meta VARCHAR(300) NULL,
                data_inicio    DATE NOT NULL,
                data_fim       DATE NOT NULL,
                status         ENUM('ativo','encerrado','cancelado') NOT NULL DEFAULT 'ativo',
                vencedor_id    INT UNSIGNED NULL,
                created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_gr_criador (criador_id),
                INDEX idx_gr_status (status),
                CONSTRAINT fk_gr_criador  FOREIGN KEY (criador_id)  REFERENCES user(id) ON DELETE CASCADE,
                CONSTRAINT fk_gr_vencedor FOREIGN KEY (vencedor_id) REFERENCES user(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `);
    console.log("[migration] gymsquad table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] gymsquad:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS gymsquad_membro (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gymsquad_id  INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                role       ENUM('membro','admin') NOT NULL DEFAULT 'membro',
                pontuacao  DECIMAL(10,2) NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_grm (gymsquad_id, user_id),
                INDEX idx_grm_user (user_id),
                CONSTRAINT fk_grm_gymsquad FOREIGN KEY (gymsquad_id) REFERENCES gymsquad(id) ON DELETE CASCADE,
                CONSTRAINT fk_grm_user   FOREIGN KEY (user_id)   REFERENCES user(id)   ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] gymsquad_membro table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] gymsquad_membro:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS gymsquad_post (
                gymsquad_id INT UNSIGNED NOT NULL,
                post_id   INT UNSIGNED NOT NULL,
                PRIMARY KEY (gymsquad_id, post_id),
                CONSTRAINT fk_grp_gymsquad FOREIGN KEY (gymsquad_id) REFERENCES gymsquad(id) ON DELETE CASCADE,
                CONSTRAINT fk_grp_post   FOREIGN KEY (post_id)   REFERENCES post(id)   ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] gymsquad_post table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] gymsquad_post:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS gymsquad_convite (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gymsquad_id  INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                status     ENUM('pendente','aceito','recusado') NOT NULL DEFAULT 'pendente',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_grc (gymsquad_id, user_id),
                CONSTRAINT fk_grc_gymsquad FOREIGN KEY (gymsquad_id) REFERENCES gymsquad(id) ON DELETE CASCADE,
                CONSTRAINT fk_grc_user   FOREIGN KEY (user_id)   REFERENCES user(id)   ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] gymsquad_convite table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] gymsquad_convite:", err.message);
  }
  try {
    await db.execute(`
            CREATE TABLE IF NOT EXISTS gymsquad_distancia (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                gymsquad_id  INT UNSIGNED NOT NULL,
                user_id    INT UNSIGNED NOT NULL,
                km         DECIMAL(6,2) NOT NULL,
                data       DATE NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_grd (gymsquad_id, user_id, data),
                CONSTRAINT fk_grd_gymsquad FOREIGN KEY (gymsquad_id) REFERENCES gymsquad(id) ON DELETE CASCADE,
                CONSTRAINT fk_grd_user   FOREIGN KEY (user_id)   REFERENCES user(id)   ON DELETE CASCADE
            ) ENGINE=InnoDB
        `);
    console.log("[migration] gymsquad_distancia table OK");
  } catch (err) {
    if (err.errno !== 1050) console.error("[migration] gymsquad_distancia:", err.message);
  }
})();

// Soft delete cron — anonimiza contas com deletion_scheduled_at vencido (a cada 24h)
(async () => {
  async function executarSoftDelete() {
    try {
      const [contas] = await db.execute(
        "SELECT id FROM user WHERE status='pendente_exclusao' AND deletion_scheduled_at <= NOW()",
      );
      for (const conta of contas) {
        await db.execute(
          `
                    UPDATE user SET
                        nome               = 'Usuário Removido',
                        email              = CONCAT('deleted_', id, '@gymbros.removed'),
                        cpf                = CONCAT('deleted_', id),
                        cpf_enc            = NULL,
                        cpf_hmac           = NULL,
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
                `,
          [conta.id],
        );
        await db
          .execute("DELETE FROM nutrition_log WHERE user_id=?", [conta.id])
          .catch(() => {});
        await db
          .execute("DELETE FROM imc_profile  WHERE user_id=?", [conta.id])
          .catch(() => {});
        await db
          .execute("DELETE FROM body_photo   WHERE user_id=?", [conta.id])
          .catch(() => {});
      }
      if (contas.length > 0)
        console.log(`[soft-delete] ${contas.length} conta(s) anonimizadas`);
    } catch (err) {
      console.error("[soft-delete cron]", err.message);
    }
  }
  setTimeout(() => {
    executarSoftDelete();
    setInterval(executarSoftDelete, 24 * 60 * 60 * 1000);
  }, 5000);
})();

// Stories cron — remove stories expirados (24h) e suas mídias no Cloudinary (a cada hora)
(async () => {
  async function limparStoriesExpirados() {
    try {
      const [expirados] = await db.execute(
        `SELECT id, public_id, tipo FROM story WHERE expira_em < NOW() AND public_id IS NOT NULL`,
      );
      for (const s of expirados) {
        try {
          await cloudinary.uploader.destroy(s.public_id, {
            resource_type: s.tipo === "video" ? "video" : "image",
          });
        } catch (_) {}
      }
      const [result] = await db.execute(
        "DELETE FROM story WHERE expira_em < NOW()",
      );
      if (result.affectedRows > 0)
        console.log(
          `[stories cron] ${result.affectedRows} story(s) expirados removidos`,
        );
    } catch (err) {
      console.error("[stories cron]", err.message);
    }
  }
  setTimeout(() => {
    limparStoriesExpirados();
    setInterval(limparStoriesExpirados, 60 * 60 * 1000);
  }, 60000);
})();

// ── Multer: upload de foto de perfil ──────────────────────────────────────────
const photoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "gymbros/profile_photos",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [
      { width: 400, height: 400, crop: "fill", gravity: "face" },
    ],
    public_id: (req) =>
      `avatar_${req.session.user?.id || Date.now()}`,
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato inválido. Use JPEG, PNG ou WebP."));
    }
    cb(null, true);
  },
});

// ── Multer: upload de foto de alimento (Groq Vision) ─────────────────────────
const fotoNutricaoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "gymbros/nutricao",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, height: 800, crop: "limit", quality: 80 }],
    public_id: (req) =>
      `nutricao_${req.session.user?.id || "anon"}_${Date.now()}`,
  },
});
const fotoNutricaoUpload = multer({
  storage: fotoNutricaoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato inválido. Use JPEG, PNG ou WebP."));
    }
    cb(null, true);
  },
});

// ── Middleware: rastreia usuários online ──────────────────────────────────────
router.use((req, res, next) => {
  if (req.session && req.session.user) {
    const user = req.session.user;
    const uid = String(user.id);
    const isNew = !onlineUsers.has(uid);
    onlineUsers.set(uid, {
      nome: user.nome,
      email: user.email,
      page: req.path,
      lastSeen: Date.now(),
    });
    if (isNew) {
      broadcast("user_online", {
        id: uid,
        nome: user.nome,
        email: user.email,
        page: req.path,
        lastSeen: Date.now(),
      });
    } else {
      broadcast("user_activity", {
        id: uid,
        nome: user.nome,
        page: req.path,
        lastSeen: Date.now(),
      });
    }
  }
  next();
});

// ── Middlewares de autenticação ───────────────────────────────────────────────

/**
 * Só exige login. Qualquer usuário autenticado passa.
 */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

/**
 * Exige login + plano ativo.
 * Pending (PIX/boleto aguardando confirmação) → redireciona com aviso.
 * Sem plano → redireciona para /planos com banner.
 */
function requirePlano(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  const user = req.session.user;

  if (!user.plano) {
    return res.redirect("/planos?semPlano=1");
  }
  next();
}

// ── Feed de posts: amigos aceitos + próprio usuário ───────────────────────────
async function buscarAmigosIds(userId) {
  try {
    const [rows] = await db.execute(
      `SELECT IF(solicitante_id = ?, destinatario_id, solicitante_id) AS id
             FROM friendship
             WHERE (solicitante_id = ? OR destinatario_id = ?) AND status = 'aceito'`,
      [userId, userId, userId],
    );
    return [userId, ...rows.map((r) => r.id)];
  } catch (err) {
    return [userId];
  }
}

// F12 — carrega um plano de treino garantindo acesso (dono ou membro aceito)
async function carregarPlanoComAcesso(planId, userId) {
  const [rows] = await db.execute(
    `SELECT wp.*, wm.status AS membro_status
       FROM workout_plans wp
       LEFT JOIN workout_membros wm
         ON wm.plan_id = wp.id AND wm.user_id = ?
      WHERE wp.id = ?`,
    [userId, planId],
  );
  if (!rows.length) return null;
  const plano = rows[0];
  const isOwner = String(plano.user_id) === String(userId);
  const isMembro = plano.membro_status === "aceito";
  if (!isOwner && !isMembro) return null;
  return { plano, isOwner, isMembro };
}

async function buscarFeedPosts(userId, lastId, lastEventId) {
  const limit = 10;
  const amigosIds = await buscarAmigosIds(userId);
  const placeholders = amigosIds.map(() => "?").join(",");
  const postCursor = lastId ? `AND p.id < ${Number(lastId)}` : "";
  const eventCursor = lastEventId ? `AND fe.id < ${Number(lastEventId)}` : "";

  const [posts] = await db.execute(
    `
        SELECT
            'post' AS _tipo,
            p.id, p.legenda, p.tipo, p.visibilidade,
            p.status, p.total_reacoes, p.total_comentarios, p.created_at,
            u.id AS autor_id, u.nome AS autor_nome,
            u.username AS autor_username,
            u.profile_photo AS autor_foto,
            NULL AS evento_tipo, NULL AS evento_payload
        FROM post p
        JOIN user u ON u.id = p.user_id
        WHERE p.user_id IN (${placeholders})
          AND p.status = 'ativo'
          AND (p.user_id = ${Number(userId)} OR p.visibilidade != 'privado')
          ${postCursor}
        ORDER BY p.id DESC
        LIMIT ${limit}
    `,
    amigosIds,
  );

  for (const post of posts) {
    const [midias] = await db.execute(
      "SELECT url, tipo, ordem, largura, altura FROM post_midia WHERE post_id = ? ORDER BY ordem",
      [post.id],
    );
    post.midias = midias;
    post.souAutor = post.autor_id === userId;

    const [[minhaReacao]] = await db.execute(
      "SELECT tipo FROM reacao WHERE post_id = ? AND user_id = ?",
      [post.id, userId],
    );
    post.minhaReacao = minhaReacao ? minhaReacao.tipo : null;
  }

  const [eventos] = await db.execute(
    `
        SELECT
            'evento' AS _tipo,
            fe.id, NULL AS legenda, NULL AS tipo, NULL AS visibilidade,
            NULL AS status, 0 AS total_reacoes, 0 AS total_comentarios, fe.created_at,
            u.id AS autor_id, u.nome AS autor_nome,
            u.username AS autor_username,
            u.profile_photo AS autor_foto,
            fe.tipo AS evento_tipo, fe.payload AS evento_payload
        FROM feed_event fe
        JOIN user u ON u.id = fe.user_id
        WHERE fe.user_id IN (${placeholders})
          ${eventCursor}
        ORDER BY fe.id DESC
        LIMIT ${limit}
    `,
    amigosIds,
  );
  for (const ev of eventos) {
    ev.souAutor = ev.autor_id === userId;
    ev.midias = [];
  }

  const items = [...posts, ...eventos]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);

  const postsIncluidos = items.filter((i) => i._tipo === "post");
  const eventosIncluidos = items.filter((i) => i._tipo === "evento");

  const novoLastId = postsIncluidos.length
    ? postsIncluidos[postsIncluidos.length - 1].id
    : (lastId ?? null);
  const novoLastEventId = eventosIncluidos.length
    ? eventosIncluidos[eventosIncluidos.length - 1].id
    : (lastEventId ?? null);

  return {
    items,
    hasMore: posts.length === limit || eventos.length === limit,
    lastId: novoLastId,
    lastEventId: novoLastEventId,
  };
}

// Função simples pra validar CPF (só pra demo)
function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, "");
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
// Landing pública — acessível sem login
router.get("/landing", (req, res) =>
  res.render("pages/index", {
    seo: {
      title: "FitCrew — Treino Inteligente com IA",
      description:
        "Treine com inteligência artificial ao seu lado. Planos de treino, dieta e acompanhamento personalizados com o FitCrew. A partir de R$ 29,90/mês.",
      keywords:
        "treino inteligente, personal trainer ia, fitcrew, treinos online, saúde, bem-estar, ia fitness",
      canonical: "/landing",
      ogTitle: "FitCrew — Treino Inteligente com IA",
      ogDescription:
        "Planos de treino e dieta personalizados por IA. Comece agora.",
    },
  }),
);

// Landing pública — sempre acessível, logado ou não
router.get("/", (req, res) => {
  res.render("pages/index", {
    seo: {
      title: "FitCrew — Treino Inteligente com IA",
      description:
        "Treine com inteligência artificial ao seu lado. Planos de treino, dieta e acompanhamento personalizados com o FitCrew. A partir de R$ 29,90/mês.",
      keywords:
        "treino inteligente, personal trainer ia, fitcrew, treinos online, saúde, bem-estar, ia fitness",
      canonical: "/",
      robots: "index, follow",
      ogTitle: "FitCrew — Treino Inteligente com IA",
      ogDescription:
        "Planos de treino e dieta personalizados por IA. Comece agora.",
    },
  });
});

router.get("/feed", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [[userData]] = await db.execute(
      "SELECT id, nome, username, profile_photo FROM user WHERE id = ?",
      [userId],
    );
    const feedData = await buscarFeedPosts(userId, null, null);
    res.render("pages/feed", {
      user: { ...req.session.user, ...(userData || {}) },
      items: feedData.items,
      hasMore: feedData.hasMore,
      lastId: feedData.lastId,
      lastEventId: feedData.lastEventId,
      page: "feed",
      seo: {
        title: "Feed — FitCrew",
        canonical: "/feed",
        robots: "noindex, nofollow",
      },
    });
  } catch (err) {
    console.error("[feed]", err.message);
    res.render("pages/feed", {
      user: req.session.user,
      items: [],
      hasMore: false,
      lastId: null,
      lastEventId: null,
      page: "feed",
      seo: {
        title: "Feed — FitCrew",
        canonical: "/feed",
        robots: "noindex, nofollow",
      },
    });
  }
});

router.get("/buscar", requireAuth, (req, res) => {
  const q = (req.query.q || "").trim();
  const aba = ["treinos", "assuntos"].includes(req.query.aba)
    ? req.query.aba
    : "pessoas";
  res.render("pages/buscar", {
    user: req.session.user,
    q,
    aba,
    seo: {
      title: q ? `Busca por "${q}" — FitCrew` : "Buscar — FitCrew",
      robots: "noindex, nofollow",
    },
  });
});

router.get("/amizades", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [amigos] = await db.execute(
      `
            SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, f.id AS friendship_id
            FROM friendship f
            JOIN user u ON u.id = IF(f.solicitante_id = ?, f.destinatario_id, f.solicitante_id)
            WHERE (f.solicitante_id = ? OR f.destinatario_id = ?)
              AND f.status = 'aceito'
              AND u.status = 'ativo'
            ORDER BY u.nome
        `,
      [uid, uid, uid],
    );
    const [solicitacoes] = await db.execute(
      `
            SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, f.id AS friendship_id
            FROM friendship f
            JOIN user u ON u.id = f.solicitante_id
            WHERE f.destinatario_id = ?
              AND f.status = 'pendente'
              AND u.status = 'ativo'
            ORDER BY f.criado_em DESC
        `,
      [uid],
    );
    res.render("pages/amizades", {
      user: req.session.user,
      amigos,
      solicitacoes,
      seo: {
        title: "Amigos — FitCrew",
        canonical: "/amizades",
        description: "Seus amigos no FitCrew",
      },
    });
  } catch (err) {
    console.error("[/amizades]", err.message);
    res.redirect("/feed");
  }
});

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/metricas");
  res.render("pages/login", {
    seo: {
      title: "Login — FitCrew",
      description:
        "Acesse sua conta FitCrew para ver seus treinos, acompanhar sua evolução e usar o personal trainer IA GymBot.",
      keywords: "login fitcrew, entrar fitcrew, acesso aluno",
      canonical: "/login",
      robots: "noindex, follow",
      ogTitle: "Entrar no FitCrew",
      ogDescription: "Acesse sua conta e continue seu treino.",
    },
  });
});

router.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("pages/register", {
    user: req.session.user || null,
    seo: {
      title: "Cadastro — FitCrew",
      description:
        "Crie sua conta FitCrew gratuitamente e acesse treinos personalizados, planos de dieta e o personal trainer IA GymBot.",
      keywords: "cadastro fitcrew, criar conta, registrar fitcrew",
      canonical: "/register",
      ogTitle: "Crie sua Conta FitCrew Grátis",
      ogDescription: "Junte-se a milhares de alunos e treine sem limites.",
    },
  });
});

router.get("/planos", (req, res) =>
  res.render("pages/planos", {
    seo: {
      title: "Planos FitCrew: GymBro e Black",
      description:
        "Compare os planos FitCrew: GymBro (R$29,90) e Black (R$59,90). Treino inteligente, IA personalizada e acompanhamento completo.",
      keywords:
        "planos fitcrew, treino com ia, assinatura fitness, plano treino ia",
      canonical: "/planos",
      ogTitle: "Escolha seu Plano FitCrew — A partir de R$29,90",
      ogDescription:
        "GymBro ou Black. Treino inteligente + IA personal trainer.",
    },
  }),
);

router.get("/academias", (req, res) =>
  res.render("pages/academias", {
    seo: {
      title: "Academias — FitCrew",
      description:
        "Encontre academias e estúdios cadastrados no FitCrew perto de você.",
      keywords:
        "academia, academia perto de mim, fitcrew academias, mapa academia",
      canonical: "/academias",
      ogTitle: "Academias FitCrew — Mapa",
      ogDescription: "Encontre academias cadastradas no FitCrew perto de você.",
    },
  }),
);

router.get("/compra", (req, res) =>
  res.render("pages/compra", {
    seo: {
      title: "Assinar FitCrew — Dados de Pagamento",
      description:
        "Finalize sua assinatura FitCrew com segurança. Acesse treinos personalizados por IA em minutos.",
      keywords: "assinar fitcrew, pagamento academia, contratar fitcrew",
      canonical: "/compra",
      robots: "noindex, nofollow",
      ogTitle: "Assinar FitCrew",
      ogDescription: "Finalize sua assinatura e comece a treinar agora.",
    },
  }),
);

router.get("/compra2", (req, res) =>
  res.render("pages/compra2", {
    seo: {
      title: "Assinar FitCrew — Confirmação de Plano",
      description:
        "Revise e confirme os dados do seu plano FitCrew antes de finalizar a assinatura.",
      keywords: "confirmar plano fitcrew, assinatura",
      canonical: "/compra2",
      robots: "noindex, nofollow",
      ogTitle: "Confirmação de Plano — FitCrew",
      ogDescription: "Revise seu plano antes de finalizar.",
    },
  }),
);

router.get("/compra3", (req, res) =>
  res.render("pages/compra3", {
    seo: {
      title: "Assinatura FitCrew Confirmada!",
      description:
        "Sua assinatura FitCrew foi confirmada! Acesse agora treinos personalizados por IA e o GymBot personal trainer IA.",
      keywords: "assinatura confirmada fitcrew, bem vindo fitcrew",
      canonical: "/compra3",
      robots: "noindex, nofollow",
      ogTitle: "Bem-vindo ao FitCrew!",
      ogDescription: "Assinatura confirmada. Comece a treinar agora mesmo!",
    },
  }),
);

// Pagamento
router.get("/pagamento", async (req, res) => {
  if (!req.session.user) {
    const plano = req.query.plano
      ? `?plano=${encodeURIComponent(req.query.plano)}`
      : "";
    return res.redirect(
      `/login?redirect=/pagamento${encodeURIComponent(plano)}`,
    );
  }
  const slug = (req.query.plano || "gymbro").toLowerCase();
  try {
    const plano = await Plan.findBySlug(slug);
    if (!plano || plano.status !== "ativo") return res.redirect("/planos");
    res.render("pages/pagamento", {
      user: req.session.user,
      plano,
      seo: {
        title: "Pagamento — FitCrew",
        canonical: "/pagamento",
        robots: "noindex, nofollow",
        description: "Finalize sua assinatura FitCrew com segurança.",
      },
    });
  } catch (err) {
    console.error("[pagamento]", err);
    res.redirect("/planos");
  }
});

router.post(
  "/api/pagamento",
  [
    body("planoId").notEmpty().withMessage("Plano obrigatório."),
    body("valor").isFloat({ min: 0.01 }).withMessage("Valor inválido."),
    body("metodo")
      .isIn(["cartao", "pix", "boleto"])
      .withMessage("Método de pagamento inválido."),
  ],
  async (req, res) => {
    if (!req.session.user)
      return res.status(401).json({ erro: "Não autorizado." });
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const {
      planoId,
      planoNome,
      valor,
      metodo,
      parcelas,
      cartaoFinal,
      bandeira,
    } = req.body;
    const user = req.session.user;
    const status = "pago";
    const valorN = Number(valor);

    try {
      const plan = await Plan.findBySlugOrName(planoId, planoNome);
      if (!plan) return res.status(400).json({ erro: "Plano não encontrado." });

      const paymentId = await Payment.create({
        user_id: user.id,
        plan_id: plan.id,
        valor_bruto: valorN,
        valor_final: valorN,
        metodo,
        parcelas: Number(parcelas) || 1,
        cartao_final: cartaoFinal || null,
        cartao_bandeira: bandeira || null,
        status,
      });

      // 3. Ativar plano via procedure
      if (status === "pago") {
        try {
          await db.execute("CALL sp_ativar_plano(?, ?, ?)", [
            user.id,
            plan.id,
            paymentId,
          ]);
        } catch (spErr) {
          console.error("[pagamento] sp_ativar_plano ERRO:", spErr.message);
        }
      }

      // 4. Atualizar sessão
      req.session.user = {
        ...user,
        plano: plan.nome,
        planoId: plan.id,
        planoSlug: plan.slug,
        status: "ativo",
      };

      // 5. Notificar admin via SSE
      broadcast("nova_compra", {
        paymentId,
        userName: user.nome,
        userEmail: user.email,
        planoNome: plan.nome,
        valor: valorN,
        metodo,
        status,
      });

      req.session.save((err) => {
        if (err) console.error("[pagamento] session save error:", err);
        return res.json({ ok: true, status, transacaoId: paymentId });
      });
    } catch (err) {
      console.error("[api/pagamento]", err);
      return res
        .status(500)
        .json({ ok: false, erro: "Erro ao processar pagamento." });
    }
  },
);

// ── GET /api/pix/qr — gera QR Code PIX ───────────────────────────────────────
router.get("/api/pix/qr", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ erro: "Não autorizado." });

  const { planoId, valor } = req.query;
  const valorNum = Number(valor) || 0;
  const valorStr = valorNum.toFixed(2);

  // EMV PIX payload simplificado (demo)
  function pixField(id, value) {
    const len = String(value.length).padStart(2, "0");
    return `${id}${len}${value}`;
  }
  const merchantInfo =
    pixField("00", "br.gov.bcb.pix") + pixField("01", "gymbros@pix.com.br");
  const payload =
    pixField("00", "01") +
    pixField("26", merchantInfo) +
    pixField("52", "0000") +
    pixField("53", "986") +
    pixField("54", valorStr) +
    pixField("58", "BR") +
    pixField("59", "GYMBROS TCC") +
    pixField("60", "Sao Paulo") +
    pixField("62", pixField("05", planoId || "pl002"));

  // CRC16 simplificado (apenas para demo — não é CRC real)
  const crc = "0000";
  const fullPayload = payload + pixField("63", crc);

  try {
    const dataUrl = await QRCode.toDataURL(fullPayload, {
      width: 220,
      margin: 1,
    });
    const expiraEm = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos
    res.json({ ok: true, dataUrl, pixPayload: fullPayload, expiraEm });
  } catch (err) {
    console.error("[pix/qr]", err);
    res.status(500).json({ ok: false, erro: "Erro ao gerar QR Code." });
  }
});

// ── POST /api/boleto — gera boleto PDF e envia e-mail ─────────────────────────
router.post("/api/boleto", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ erro: "Não autorizado." });

  const { planoNome, valor } = req.body;
  const user = req.session.user;

  const linhaDigitavel =
    "23790.00009 01020.269702 03010.247409 8 94350000006490";
  const vencimento = new Date();
  vencimento.setDate(vencimento.getDate() + 3);
  const vencimentoStr = vencimento.toLocaleDateString("pt-BR");

  try {
    const pdfBuffer = await gerarBoletoPDF({
      nome: user.nome,
      email: user.email,
      planoNome,
      valor: Number(valor),
      linhaDigitavel,
      vencimento: vencimentoStr,
    });

    await enviarBoleto({
      to: user.email,
      nome: user.nome,
      planoNome,
      valor: Number(valor),
      linhaDigitavel,
      pdfBuffer,
    });

    res.json({
      ok: true,
      linhaDigitavel,
      vencimento: vencimentoStr,
      emailEnviado: true,
    });
  } catch (err) {
    console.error("[boleto]", err);
    res.status(500).json({ ok: false, erro: "Erro ao gerar boleto." });
  }
});

router.get("/about", (req, res) =>
  res.render("pages/about", {
    seo: {
      title: "Sobre o FitCrew — Nossa Missão e Equipe",
      description:
        "Conheça a história do FitCrew, nossa missão de democratizar o acesso à saúde e fitness no Brasil e o time apaixonado por esporte.",
      keywords:
        "sobre fitcrew, história fitcrew, missão fitcrew, equipe fitcrew",
      canonical: "/about",
      ogTitle: "Sobre o FitCrew — Saúde para Todos",
      ogDescription:
        "Nossa missão: democratizar o acesso à saúde e ao fitness no Brasil.",
    },
  }),
);

router.get("/privacidade", (req, res) =>
  res.render("pages/privacidade", {
    user: req.session.user || null,
    seo: {
      title: "Política de Privacidade — FitCrew",
      description:
        "Saiba como o FitCrew coleta, usa e protege seus dados pessoais em conformidade com a LGPD.",
      keywords:
        "política de privacidade fitcrew, lgpd fitcrew, proteção de dados fitcrew",
      canonical: "/privacidade",
      ogTitle: "Política de Privacidade — FitCrew",
      ogDescription:
        "Transparência total sobre como tratamos seus dados pessoais.",
    },
  }),
);

router.get("/termos", (req, res) =>
  res.render("pages/termos", {
    user: req.session.user || null,
    seo: {
      title: "Termos de Serviço — FitCrew",
      description:
        "Leia os termos e condições de uso da plataforma FitCrew: planos, pagamentos, cancelamento e uso aceitável.",
      keywords:
        "termos de serviço fitcrew, termos de uso fitcrew, condições fitcrew",
      canonical: "/termos",
      ogTitle: "Termos de Serviço — FitCrew",
      ogDescription:
        "Conheça as regras e condições para uso da plataforma FitCrew.",
    },
  }),
);

router.get("/faq", (req, res) =>
  res.render("pages/faq", {
    user: req.session.user || null,
    seo: {
      title: "FAQ — Perguntas Frequentes | FitCrew",
      description:
        "Respostas para as dúvidas mais comuns sobre o FitCrew: acesso a academias, planos, pagamentos, IA e suporte.",
      keywords: "faq fitcrew, dúvidas fitcrew, perguntas frequentes fitcrew",
      canonical: "/faq",
      ogTitle: "Perguntas Frequentes — FitCrew",
      ogDescription:
        "Tire suas dúvidas sobre o FitCrew: planos, academias, pagamentos e mais.",
    },
  }),
);

// F6 — Scanner de QR Code
router.get("/scan", requireAuth, (req, res) => {
  res.render("pages/scan", {
    user: req.session.user,
    seo: { title: "Escanear Equipamento — FitCrew", robots: "noindex" },
  });
});

// F6 — Página do equipamento (requer login)
router.get("/equipamento/:qr_token", requireAuth, async (req, res) => {
  try {
    const [[equipamento]] = await db.execute(
      `SELECT e.*, g.nome AS academia_nome
             FROM equipamento e
             LEFT JOIN gym g ON g.id = e.academia_id
             WHERE e.qr_token = ? AND e.ativo = 1`,
      [req.params.qr_token],
    );
    if (!equipamento)
      return res.status(404).render("pages/404", { user: req.session.user });

    const [exercicios] = await db.execute(
      `
            SELECT ex.id, ex.name, ex.name_pt, ex.target_muscle, ex.body_part,
                   em.cloudinary_gif_url AS gif_url
            FROM equipamento_exercicio ee
            JOIN exercises ex ON ex.id = ee.exercise_id
            LEFT JOIN exercise_media em ON em.exercise_id = ex.id
            WHERE ee.equipamento_id = ?
            ORDER BY ex.name ASC
        `,
      [equipamento.id],
    );

    // F9 — registrar scan
    await db
      .execute(
        "INSERT INTO equipamento_scan (equipamento_id, user_id) VALUES (?, ?)",
        [equipamento.id, req.session.user.id],
      )
      .catch(() => {});

    res.render("pages/equipamento", {
      user: req.session.user,
      equipamento,
      exercicios,
      seo: {
        title: `${equipamento.nome} — FitCrew`,
        robots: "noindex",
        description: `Exercícios no ${equipamento.nome} com GIFs de execução.`,
      },
    });
  } catch (err) {
    console.error("[equipamento]", err.message);
    res.redirect("/area-aluno");
  }
});

// Área do Aluno (protegida — requer plano ativo)
router.get("/area-aluno", requirePlano, async (req, res) => {
  if (!req.session.user.imc) {
    return res.redirect("/imc-form?primeiro=1");
  }
  const uid = req.session.user.id;
  try {
    const [[extraRow], [[cqRow]], [[semanaRow]], ultimasConqRows] =
      await Promise.all([
        db.execute(
          "SELECT last_imc_update, last_avaliacao_update, notification_interval_days FROM user WHERE id = ?",
          [uid],
        ),
        db.execute(
          "SELECT COUNT(*) as total FROM usuario_conquistas WHERE user_id = ?",
          [uid],
        ),
        db.execute(
          "SELECT COUNT(*) as semana FROM treino_checkins WHERE user_id = ? AND YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)",
          [uid],
        ),
        db.execute(
          `SELECT c.nome, c.icone, c.tier FROM usuario_conquistas uc JOIN conquistas c ON c.id = uc.conquista_id WHERE uc.user_id = ? ORDER BY uc.desbloqueada_em DESC LIMIT 2`,
          [uid],
        ),
      ]);
    const extra = extraRow[0] || {};
    const totalConquistas = cqRow?.total || 0;
    const checkinsNaSemana = semanaRow?.semana || 0;
    const metaSemanal = Math.min(Math.round((checkinsNaSemana / 5) * 100), 100);
    const ultimasConquistas = ultimasConqRows[0] || [];

    res.render("pages/area-aluno", {
      user: { ...req.session.user, ...extra },
      totalConquistas,
      checkinsNaSemana,
      metaSemanal,
      ultimasConquistas,
      seo: {
        title: "Painel do Aluno — FitCrew",
        canonical: "/area-aluno",
        robots: "noindex, nofollow",
        description: "Painel do aluno FitCrew.",
      },
    });
  } catch (err) {
    console.error("[area-aluno]", err);
    res.render("pages/area-aluno", {
      user: req.session.user,
      totalConquistas: 0,
      checkinsNaSemana: 0,
      metaSemanal: 0,
      ultimasConquistas: [],
      seo: {
        title: "Painel do Aluno — FitCrew",
        canonical: "/area-aluno",
        robots: "noindex, nofollow",
        description: "Painel do aluno FitCrew.",
      },
    });
  }
});

// Métricas — antiga página inicial movida para /metricas
router.get("/metricas", requirePlano, async (req, res) => {
  if (!req.session.user.imc) {
    return res.redirect("/imc-form?primeiro=1");
  }
  const uid = req.session.user.id;
  try {
    const [[extraRow], [[cqRow]], [[semanaRow]], ultimasConqRows] =
      await Promise.all([
        db.execute(
          "SELECT last_imc_update, last_avaliacao_update, notification_interval_days FROM user WHERE id = ?",
          [uid],
        ),
        db.execute(
          "SELECT COUNT(*) as total FROM usuario_conquistas WHERE user_id = ?",
          [uid],
        ),
        db.execute(
          "SELECT COUNT(*) as semana FROM treino_checkins WHERE user_id = ? AND YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)",
          [uid],
        ),
        db.execute(
          `SELECT c.nome, c.icone, c.tier FROM usuario_conquistas uc JOIN conquistas c ON c.id = uc.conquista_id WHERE uc.user_id = ? ORDER BY uc.desbloqueada_em DESC LIMIT 2`,
          [uid],
        ),
      ]);
    const extra = extraRow[0] || {};
    const totalConquistas = cqRow?.total || 0;
    const checkinsNaSemana = semanaRow?.semana || 0;
    const metaSemanal = Math.min(Math.round((checkinsNaSemana / 5) * 100), 100);
    const ultimasConquistas = ultimasConqRows[0] || [];
    res.render("pages/area-aluno", {
      user: { ...req.session.user, ...extra },
      totalConquistas,
      checkinsNaSemana,
      metaSemanal,
      ultimasConquistas,
      seo: {
        title: "Minhas Métricas — FitCrew",
        canonical: "/metricas",
        robots: "noindex, nofollow",
        description: "Métricas do aluno FitCrew.",
      },
    });
  } catch (err) {
    console.error("[metricas]", err);
    res.render("pages/area-aluno", {
      user: req.session.user,
      totalConquistas: 0,
      checkinsNaSemana: 0,
      metaSemanal: 0,
      ultimasConquistas: [],
      seo: {
        title: "Minhas Métricas — FitCrew",
        canonical: "/metricas",
        robots: "noindex, nofollow",
        description: "Métricas do aluno FitCrew.",
      },
    });
  }
});

router.post("/config/notificacao-intervalo", requireAuth, async (req, res) => {
  const dias = Math.max(1, parseInt(req.body.dias) || 7);
  try {
    await db.execute(
      "UPDATE user SET notification_interval_days = ? WHERE id = ?",
      [dias, req.session.user.id],
    );
    req.session.user.notification_interval_days = dias;
    res.json({ ok: true });
  } catch (err) {
    console.error("[notificacao-intervalo]", err);
    res.status(500).json({ ok: false });
  }
});

//Treinos
const SUGESTOES_TREINO = [
  {
    id: 1,
    nome: "Treino de Peito",
    duracao: 50,
    tipo: "Força",
    icone: "fa-dumbbell",
    exercicios: ["Supino reto", "Crucifixo", "Peck deck", "Flexão"],
  },
  {
    id: 2,
    nome: "Treino de Pernas",
    duracao: 60,
    tipo: "Força",
    icone: "fa-dumbbell",
    exercicios: [
      "Agachamento",
      "Leg press",
      "Cadeira extensora",
      "Panturrilha",
    ],
  },
  {
    id: 3,
    nome: "Yoga Relaxamento",
    duracao: 40,
    tipo: "Alongamento",
    icone: "fa-leaf",
    exercicios: ["Saudação ao sol", "Postura da criança", "Torção espinhal"],
  },
  {
    id: 4,
    nome: "Treino de Costas",
    duracao: 55,
    tipo: "Força",
    icone: "fa-dumbbell",
    exercicios: ["Remada curvada", "Puxada frontal", "Remada unilateral"],
  },
  {
    id: 5,
    nome: "Treino de Ombros",
    duracao: 45,
    tipo: "Força",
    icone: "fa-dumbbell",
    exercicios: ["Desenvolvimento", "Elevação lateral", "Elevação frontal"],
  },
  {
    id: 6,
    nome: "Cardio Intenso",
    duracao: 35,
    tipo: "Cardio",
    icone: "fa-running",
    exercicios: ["Esteira 20min", "Bicicleta 15min"],
  },
  {
    id: 7,
    nome: "Pilates",
    duracao: 50,
    tipo: "Alongamento",
    icone: "fa-leaf",
    exercicios: ["Controle respiratório", "Fortalecimento core"],
  },
  {
    id: 8,
    nome: "Treino Abdominal",
    duracao: 30,
    tipo: "Força",
    icone: "fa-dumbbell",
    exercicios: ["Crunch", "Prancha", "Abdominal oblíquo"],
  },
  {
    id: 9,
    nome: "HIIT",
    duracao: 25,
    tipo: "Cardio",
    icone: "fa-fire",
    exercicios: ["Burpee", "Mountain climber", "Jumping jack", "Sprint"],
  },
];

let _gifCache = null;
let _gifCacheAt = 0;
const GIF_TTL_MS = 24 * 60 * 60 * 1000;

async function getGifCache() {
  if (_gifCache && Date.now() - _gifCacheAt < GIF_TTL_MS) return _gifCache;
  const [rows] = await db.execute(
    `SELECT e.name, em.cloudinary_gif_url
         FROM exercises e
         JOIN exercise_media em ON em.exercise_id = e.id`,
  );
  _gifCache = rows.map((r) => ({
    name: r.name,
    gif_url: r.cloudinary_gif_url,
  }));
  _gifCacheAt = Date.now();
  return _gifCache;
}

async function lookupGif(query, cache) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  const exact = cache.find((r) => r.name.toLowerCase() === q);
  if (exact) return exact.gif_url;
  const fuse = new Fuse(cache, { keys: ["name"], threshold: 0.4 });
  const results = fuse.search(query);
  return results.length > 0 ? results[0].item.gif_url : null;
}

router.get("/treinos", requirePlano, async (req, res) => {
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
      [req.session.user.id],
    );
  } catch (err) {
    console.error("[treinos]", err);
  }
  try {
    const [planRows] = await db.execute(
      "SELECT * FROM workout_plans WHERE user_id = ? ORDER BY created_at ASC",
      [req.session.user.id],
    );
    iaPlanos = planRows.map((row) => ({
      ...row,
      exercicios_json:
        typeof row.exercicios_json === "string"
          ? JSON.parse(row.exercicios_json)
          : row.exercicios_json,
    }));
  } catch (err) {
    console.error("[treinos/iaPlanos]", err);
  }
  try {
    const gifCache = await getGifCache();
    for (const plano of iaPlanos) {
      for (const ex of plano.exercicios_json) {
        ex.gif_url = await lookupGif(ex.exercise_query, gifCache);
      }
    }
  } catch (err) {
    console.error("[treinos/gifs]", err);
  }

  // F12 — treinos onde o usuário é membro aceito (compartilhados por amigos)
  let treinosCompartilhados = [];
  try {
    const [compartRows] = await db.execute(
      `SELECT wp.*, u.nome AS dono_nome, u.username AS dono_username,
              u.profile_photo AS dono_foto
         FROM workout_membros wm
         JOIN workout_plans wp ON wp.id = wm.plan_id
         JOIN user u ON u.id = wp.user_id
        WHERE wm.user_id = ? AND wm.status = 'aceito'
        ORDER BY wm.updated_at DESC`,
      [req.session.user.id],
    );
    treinosCompartilhados = compartRows.map((row) => ({
      ...row,
      exercicios_json:
        typeof row.exercicios_json === "string"
          ? JSON.parse(row.exercicios_json)
          : row.exercicios_json || [],
    }));
    const gifCache = await getGifCache();
    for (const plano of treinosCompartilhados) {
      for (const ex of plano.exercicios_json) {
        ex.gif_url = await lookupGif(ex.exercise_query, gifCache);
      }
    }
  } catch (err) {
    console.error("[treinos/compartilhados]", err);
  }

  res.render("pages/treinos", {
    user: req.session.user,
    workouts,
    iaPlanos,
    treinosCompartilhados,
    sugestoes: SUGESTOES_TREINO,
    seo: {
      title: "Meus Treinos — FitCrew",
      canonical: "/treinos",
      robots: "noindex, nofollow",
      description: "Gerencie seus treinos no FitCrew.",
    },
  });
});

// DELETE /treinos/plano/:id — remove plano de treino da IA
router.delete("/treinos/plano/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planoId = parseInt(req.params.id, 10);
  if (!planoId) return res.status(400).json({ ok: false });
  try {
    const [result] = await db.execute(
      "DELETE FROM workout_plans WHERE id = ? AND user_id = ?",
      [planoId, userId],
    );
    if (!result.affectedRows)
      return res
        .status(404)
        .json({ ok: false, error: "Plano não encontrado." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[treinos/plano/delete]", err.message);
    return res.status(500).json({ ok: false, error: "Erro ao deletar." });
  }
});

// POST /treinos/checkin — registra presença manual (máx 1 por dia)
router.post("/treinos/checkin", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [existing] = await db.execute(
      `SELECT id FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1`,
      [userId],
    );
    if (existing.length > 0) {
      return res
        .status(409)
        .json({ ok: false, erro: "Você já registrou presença hoje." });
    }
    const [result] = await db.execute(
      "INSERT INTO treino_checkins (user_id) VALUES (?)",
      [userId],
    );
    const [rows] = await db.execute(
      "SELECT created_at FROM treino_checkins WHERE id = ?",
      [result.insertId],
    );

    const novasSlugs = await conquistas
      .verificarConsistencia(userId)
      .catch(() => []);
    let novasConquistas = [];
    if (novasSlugs.length) {
      const placeholders = novasSlugs.map(() => "?").join(",");
      const [detalhes] = await db.execute(
        `SELECT slug, nome, tier, icone FROM conquistas WHERE slug IN (${placeholders})`,
        novasSlugs,
      );
      novasConquistas = detalhes;
    }

    atualizarGymSquadsUsuario(userId).catch(() => {});

    return res.json({
      ok: true,
      checkinId: result.insertId,
      created_at: rows[0].created_at,
      novasConquistas,
    });
  } catch (err) {
    console.error("[checkin]", err.message);
    return res
      .status(500)
      .json({ ok: false, erro: "Erro ao registrar check-in." });
  }
});

// GET /treinos/checkin/status — retorna status do check-in do dia + streak
router.get("/treinos/checkin/status", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [todayRows] = await db.execute(
      `SELECT created_at FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1`,
      [userId],
    );
    const checkedInToday = todayRows.length > 0;
    const todayCheckin = checkedInToday ? todayRows[0].created_at : null;

    const [lastRows] = await db.execute(
      `SELECT created_at FROM treino_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const lastCheckin = lastRows.length > 0 ? lastRows[0].created_at : null;

    let diasSemCheckin = 0;
    if (lastCheckin) {
      diasSemCheckin = Math.floor(
        (Date.now() - new Date(lastCheckin)) / 86400000,
      );
    }

    // Streak: dias consecutivos com check-in
    const [dateRows] = await db.execute(
      `SELECT DATE(created_at) AS data
             FROM treino_checkins WHERE user_id = ?
             GROUP BY DATE(created_at) ORDER BY data DESC`,
      [userId],
    );
    let streak = 0;
    if (dateRows.length > 0) {
      const todayStr = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const toDate = (s) =>
        s instanceof Date
          ? s.toISOString().slice(0, 10)
          : String(s).slice(0, 10);
      const dateSet = new Set(dateRows.map((r) => toDate(r.data)));
      let cursor = new Date(todayStr + "T12:00:00Z");
      if (!checkedInToday) cursor = new Date(cursor.getTime() - 86400000);
      while (dateSet.has(cursor.toISOString().slice(0, 10))) {
        streak++;
        cursor = new Date(cursor.getTime() - 86400000);
      }
    }

    return res.json({
      checkedInToday,
      lastCheckin: todayCheckin,
      diasSemCheckin,
      streak,
    });
  } catch (err) {
    console.error("[checkin/status]", err.message);
    return res.status(500).json({ erro: "Erro ao buscar status." });
  }
});

// ── Execução de Treino (F15) ──────────────────────────────────────────────────

// GET /treinos/execucao — página fullscreen de execução
router.get("/treinos/execucao", requirePlano, async (req, res) => {
  const userId = req.session.user.id;
  const planoId = parseInt(req.query.plano_id, 10);
  if (!planoId) return res.redirect("/treinos");

  let plano;
  try {
    const [rows] = await db.execute(
      `SELECT wp.* FROM workout_plans wp
         LEFT JOIN workout_membros wm
           ON wm.plan_id = wp.id AND wm.user_id = ? AND wm.status = 'aceito'
        WHERE wp.id = ? AND (wp.user_id = ? OR wm.id IS NOT NULL)`,
      [userId, planoId, userId],
    );
    if (!rows.length) return res.redirect("/treinos");
    plano = rows[0];
    plano.exercicios_json =
      typeof plano.exercicios_json === "string"
        ? JSON.parse(plano.exercicios_json)
        : plano.exercicios_json || [];
  } catch (err) {
    console.error("[execucao]", err.message);
    return res.redirect("/treinos");
  }

  // Enriquecer exercícios com GIF, músculos e instruções
  try {
    const [exRows] = await db.execute(`
            SELECT e.name, e.target_muscle, e.body_part, e.instructions_json,
                   em.cloudinary_gif_url
            FROM exercises e
            LEFT JOIN exercise_media em ON em.exercise_id = e.id
        `);
    const exList = exRows.map((r) => ({
      name: r.name,
      gif_url: r.cloudinary_gif_url || null,
      target_muscle: r.target_muscle || null,
      body_part: r.body_part || null,
      instructions: safeJson(r.instructions_json, []),
    }));
    const fuse = new Fuse(exList, { keys: ["name"], threshold: 0.4 });

    for (const ex of plano.exercicios_json) {
      const q = (ex.exercise_query || "").toLowerCase().trim();
      const exact = exList.find((r) => r.name.toLowerCase() === q);
      const match = exact || fuse.search(ex.exercise_query || "")[0]?.item;
      ex.gif_url = match?.gif_url ?? null;
      ex.target_muscle = match?.target_muscle ?? null;
      ex.body_part = match?.body_part ?? null;
      ex.instructions = match?.instructions ?? [];
    }
  } catch (err) {
    console.error("[execucao/enrich]", err.message);
  }

  // Verificar sessão em andamento hoje
  let sessaoExistente = null;
  try {
    const [sRows] = await db.execute(
      `
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
        `,
      [userId, planoId],
    );
    if (sRows.length) {
      sessaoExistente = sRows[0];
      sessaoExistente.exercicios_status =
        typeof sessaoExistente.exercicios_status === "string"
          ? JSON.parse(sessaoExistente.exercicios_status)
          : sessaoExistente.exercicios_status || [];
    }
  } catch (err) {
    console.error("[execucao/sessao]", err.message);
  }

  res.render("pages/execucao-treino", {
    user: req.session.user,
    plano,
    sessaoExistente,
    seo: {
      title: `${plano.nome} — FitCrew`,
      canonical: `/treinos/execucao?plano_id=${planoId}`,
      robots: "noindex, nofollow",
      description: "Modo de execução de treino.",
    },
  });
});

// POST /treinos/sessao/iniciar
router.post("/treinos/sessao/iniciar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { workout_plan_id } = req.body;
  if (!workout_plan_id)
    return res.status(400).json({ erro: "workout_plan_id obrigatório." });
  try {
    const [planRows] = await db.execute(
      `SELECT wp.id, wp.exercicios_json FROM workout_plans wp
         LEFT JOIN workout_membros wm
           ON wm.plan_id = wp.id AND wm.user_id = ? AND wm.status = 'aceito'
        WHERE wp.id = ? AND (wp.user_id = ? OR wm.id IS NOT NULL)`,
      [userId, workout_plan_id, userId],
    );
    if (!planRows.length)
      return res.status(404).json({ erro: "Plano não encontrado." });

    const [existing] = await db.execute(
      `
            SELECT id FROM treino_sessao
            WHERE user_id = ? AND workout_plan_id = ?
              AND status = 'em_andamento' AND DATE(iniciado_em) = CURDATE()
            LIMIT 1
        `,
      [userId, workout_plan_id],
    );

    if (existing.length) {
      const [exRows] = await db.execute(
        "SELECT * FROM treino_sessao_exercicio WHERE sessao_id = ?",
        [existing[0].id],
      );
      return res.json({
        sessao_id: existing[0].id,
        exercicios: exRows,
        retomada: true,
      });
    }

    const [result] = await db.execute(
      "INSERT INTO treino_sessao (user_id, workout_plan_id) VALUES (?, ?)",
      [userId, workout_plan_id],
    );
    const sessaoId = result.insertId;
    const exercicios = safeJson(planRows[0].exercicios_json, []);
    for (const ex of exercicios) {
      if (ex.exercise_query) {
        await db.execute(
          "INSERT IGNORE INTO treino_sessao_exercicio (sessao_id, exercise_query) VALUES (?, ?)",
          [sessaoId, ex.exercise_query],
        );
      }
    }
    const [exRows] = await db.execute(
      "SELECT * FROM treino_sessao_exercicio WHERE sessao_id = ?",
      [sessaoId],
    );
    return res.json({
      sessao_id: sessaoId,
      exercicios: exRows,
      retomada: false,
    });
  } catch (err) {
    console.error("[sessao/iniciar]", err.message);
    return res.status(500).json({ erro: "Erro ao iniciar sessão." });
  }
});

// POST /treinos/sessao/exercicio/concluir
router.post(
  "/treinos/sessao/exercicio/concluir",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const { sessao_id, exercise_query, series_realizadas, carga_usada } =
      req.body;
    if (!sessao_id || !exercise_query)
      return res.status(400).json({ erro: "Campos obrigatórios ausentes." });
    try {
      const [sRows] = await db.execute(
        "SELECT id FROM treino_sessao WHERE id = ? AND user_id = ? AND status = 'em_andamento'",
        [sessao_id, userId],
      );
      if (!sRows.length)
        return res.status(404).json({ erro: "Sessão não encontrada." });

      await db.execute(
        `
            INSERT INTO treino_sessao_exercicio (sessao_id, exercise_query, series_realizadas, carga_usada, concluido)
            VALUES (?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                series_realizadas = VALUES(series_realizadas),
                carga_usada       = VALUES(carga_usada),
                concluido         = 1
        `,
        [
          sessao_id,
          exercise_query,
          series_realizadas || 0,
          carga_usada || null,
        ],
      );

      // Verificar conquistas de peso/cardio
      const novasConquistas = [];
      try {
        const [exRows] = await db.execute(
          "SELECT body_part FROM exercises WHERE LOWER(name) = LOWER(?) LIMIT 1",
          [exercise_query],
        );
        const bodyPart = exRows[0]?.body_part || null;
        const pesoKg =
          parseFloat(String(carga_usada || "").replace(/[^\d.]/g, "")) || 0;
        if (bodyPart) {
          if (bodyPart === "cardio" && pesoKg > 0) {
            const nc = await conquistas.verificarCardio(userId, pesoKg);
            novasConquistas.push(...nc);
          } else if (pesoKg > 0) {
            const nc = await conquistas.verificarPeso(userId, bodyPart, pesoKg);
            novasConquistas.push(...nc);
          }
        }
      } catch (e) {
        console.error("[sessao/exercicio/concluir] conquistas:", e.message);
      }

      let novasDetalhes = [];
      if (novasConquistas.length) {
        const placeholders = novasConquistas.map(() => "?").join(",");
        const [detalhes] = await db.execute(
          `SELECT slug, nome, tier, icone FROM conquistas WHERE slug IN (${placeholders})`,
          novasConquistas,
        );
        novasDetalhes = detalhes;
      }
      return res.json({ ok: true, novasConquistas: novasDetalhes });
    } catch (err) {
      console.error("[sessao/exercicio/concluir]", err.message);
      return res.status(500).json({ erro: "Erro ao concluir exercício." });
    }
  },
);

// POST /treinos/sessao/abandonar
router.post("/treinos/sessao/abandonar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { sessao_id } = req.body;
  if (!sessao_id)
    return res.status(400).json({ erro: "sessao_id obrigatório." });
  try {
    await db.execute(
      "UPDATE treino_sessao SET status = 'abandonado', finalizado_em = NOW() WHERE id = ? AND user_id = ?",
      [sessao_id, userId],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[sessao/abandonar]", err.message);
    return res.status(500).json({ erro: "Erro ao abandonar sessão." });
  }
});

// POST /treinos/sessao/finalizar
router.post("/treinos/sessao/finalizar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { sessao_id } = req.body;
  if (!sessao_id)
    return res.status(400).json({ erro: "sessao_id obrigatório." });
  try {
    const [sRows] = await db.execute(
      "SELECT id FROM treino_sessao WHERE id = ? AND user_id = ? AND status = 'em_andamento'",
      [sessao_id, userId],
    );
    if (!sRows.length)
      return res
        .status(404)
        .json({ erro: "Sessão não encontrada ou já finalizada." });

    await db.execute(
      "UPDATE treino_sessao SET status = 'completo', finalizado_em = NOW() WHERE id = ?",
      [sessao_id],
    );

    const [chkExisting] = await db.execute(
      "SELECT id FROM treino_checkins WHERE user_id = ? AND DATE(created_at) = CURDATE() LIMIT 1",
      [userId],
    );
    if (!chkExisting.length) {
      await db.execute("INSERT INTO treino_checkins (user_id) VALUES (?)", [
        userId,
      ]);
    }

    // Verificar conquistas: peso/cardio de todos os exercícios + consistência
    const novasSlugs = [];
    try {
      const [exRows] = await db.execute(
        `SELECT tse.carga_usada, e.body_part
                 FROM treino_sessao_exercicio tse
                 LEFT JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
                 WHERE tse.sessao_id = ? AND tse.concluido = 1`,
        [sessao_id],
      );
      for (const ex of exRows) {
        const grupo = ex.body_part;
        const pesoKg =
          parseFloat(String(ex.carga_usada || "").replace(/[^\d.]/g, "")) || 0;
        if (grupo && pesoKg > 0) {
          const nc =
            grupo === "cardio"
              ? await conquistas.verificarCardio(userId, pesoKg)
              : await conquistas.verificarPeso(userId, grupo, pesoKg);
          novasSlugs.push(...nc);
        }
      }
    } catch (e) {
      console.error("[sessao/finalizar] peso:", e.message);
    }
    const ncConsist = await conquistas
      .verificarConsistencia(userId)
      .catch(() => []);
    novasSlugs.push(...ncConsist);

    let novasConquistas = [];
    if (novasSlugs.length) {
      const placeholders = novasSlugs.map(() => "?").join(",");
      const [detalhes] = await db.execute(
        `SELECT slug, nome, tier, icone FROM conquistas WHERE slug IN (${placeholders})`,
        novasSlugs,
      );
      novasConquistas = detalhes;
    }

    atualizarGymSquadsUsuario(userId).catch(() => {});

    return res.json({ ok: true, sessao_id, novasConquistas });
  } catch (err) {
    console.error("[sessao/finalizar]", err.message);
    return res.status(500).json({ erro: "Erro ao finalizar sessão." });
  }
});

// GET /treinos/sessao/historico
router.get("/treinos/sessao/historico", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [rows] = await db.execute(
      `
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
        `,
      [userId],
    );
    return res.json({ ok: true, historico: rows });
  } catch (err) {
    console.error("[sessao/historico]", err.message);
    return res.status(500).json({ erro: "Erro ao buscar histórico." });
  }
});

// GET /api/treinos/sessao/:id/replay — dados do replay (stats + exercícios + músculos)
router.get("/api/treinos/sessao/:id/replay", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const sessaoId = parseInt(req.params.id, 10);
  if (!sessaoId) return res.status(400).json({ erro: "ID inválido." });

  try {
    const [[sessao]] = await db.execute(
      `SELECT ts.id, ts.iniciado_em, ts.finalizado_em, ts.status,
              wp.nome AS treino_nome
       FROM treino_sessao ts
       LEFT JOIN workout_plans wp ON wp.id = ts.workout_plan_id
       WHERE ts.id = ? AND ts.user_id = ? AND ts.status = 'completo'
       LIMIT 1`,
      [sessaoId, userId],
    );
    if (!sessao)
      return res.status(404).json({ erro: "Sessão não encontrada." });

    const [exercicios] = await db.execute(
      `SELECT tse.exercise_query, tse.series_realizadas, tse.carga_usada, tse.concluido,
              e.name, e.name_pt, e.body_part, e.target_muscle,
              em.cloudinary_gif_url AS gif_url
       FROM treino_sessao_exercicio tse
       LEFT JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
       LEFT JOIN exercise_media em ON em.exercise_id = e.id
       WHERE tse.sessao_id = ?
       ORDER BY tse.id ASC`,
      [sessaoId],
    );

    const duracaoMin =
      sessao.finalizado_em && sessao.iniciado_em
        ? Math.round(
            (new Date(sessao.finalizado_em) - new Date(sessao.iniciado_em)) /
              60000,
          )
        : null;

    let volumeTotal = 0;
    let exerciciosConcluidos = 0;
    const gruposAtivados = new Set();
    exercicios.forEach((ex) => {
      if (!ex.concluido) return;
      exerciciosConcluidos++;
      const carga =
        parseFloat(String(ex.carga_usada || "0").replace(/[^\d.]/g, "")) || 0;
      volumeTotal += (ex.series_realizadas || 0) * carga;
      if (ex.body_part) gruposAtivados.add(ex.body_part);
      if (ex.target_muscle) gruposAtivados.add(ex.target_muscle);
    });

    res.json({
      sessao: {
        ...sessao,
        duracao_min: duracaoMin,
        volume_total: Math.round(volumeTotal),
        total_exercicios: exerciciosConcluidos,
        grupos_ativados: [...gruposAtivados],
      },
      exercicios,
    });
  } catch (err) {
    console.error("[/api/treinos/sessao/:id/replay]", err.message);
    res.status(500).json({ erro: "Erro ao buscar replay." });
  }
});

// GET /treinos/sessao/:id/replay — página do replay (fullscreen, sem sidebar)
router.get("/treinos/sessao/:id/replay", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const sessaoId = parseInt(req.params.id, 10);
  if (!sessaoId) return res.redirect("/treinos");

  try {
    const [[sessao]] = await db.execute(
      'SELECT id FROM treino_sessao WHERE id = ? AND user_id = ? AND status = "completo"',
      [sessaoId, userId],
    );
    if (!sessao) return res.redirect("/treinos");

    res.render("pages/replay-treino", {
      user: req.session.user,
      sessaoId,
      page: "treinos",
      seo: {
        title: "Replay do Treino — FitCrew",
        canonical: `/treinos/sessao/${sessaoId}/replay`,
        robots: "noindex, nofollow",
      },
    });
  } catch (err) {
    console.error("[/treinos/sessao/:id/replay]", err.message);
    res.redirect("/treinos");
  }
});

// POST /internal/checkin-alerts — lista usuários com 3+ dias sem check-in (Web Push vem na F10)
router.post("/internal/checkin-alerts", async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_KEY) {
    return res.status(401).json({ erro: "Não autorizado." });
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
    console.error("[checkin-alerts]", err.message);
    return res.status(500).json({ erro: "Erro interno." });
  }
});

//Evolução
router.get("/evolucao", requirePlano, async (req, res) => {
  const uid = req.session.user.id;
  const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  let checkins = [],
    workoutLogs = [],
    measurements = [];
  try {
    [[checkins], [workoutLogs], [measurements]] = await Promise.all([
      db.execute(
        `SELECT data, dia_semana, COUNT(*) as total
                 FROM checkin
                 WHERE user_id = ? AND data >= CURDATE() - INTERVAL 30 DAY
                 GROUP BY data, dia_semana
                 ORDER BY data ASC`,
        [uid],
      ),
      db.execute(
        `SELECT wl.*, w.nome as workout_nome
                 FROM workout_log wl
                 LEFT JOIN workout w ON w.id = wl.workout_id
                 WHERE wl.user_id = ? AND wl.data >= CURDATE() - INTERVAL 30 DAY
                 ORDER BY wl.data DESC`,
        [uid],
      ),
      db.execute(
        `SELECT * FROM measurement WHERE user_id = ? ORDER BY data DESC LIMIT 10`,
        [uid],
      ),
    ]);
  } catch (err) {
    console.error("[evolucao]", err);
  }

  const contPorDia = [0, 0, 0, 0, 0, 0, 0];
  checkins.forEach((c) => {
    const d = new Date(c.data);
    contPorDia[d.getDay()] += Number(c.total) || 0;
  });

  let exerciciosExecutados = [],
    volumeSemanal = [];
  try {
    [exerciciosExecutados] = await db.execute(
      `
            SELECT DISTINCT e.id, e.name, e.name_pt, e.name_es, e.body_part
            FROM treino_sessao_exercicio tse
            JOIN treino_sessao ts ON ts.id = tse.sessao_id
            JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
            WHERE ts.user_id = ? AND ts.status = 'completo'
              AND tse.carga_usada IS NOT NULL AND tse.carga_usada != ''
              AND (tse.carga_usada + 0) > 0
            ORDER BY e.name ASC
        `,
      [uid],
    );
  } catch (err) {
    console.error("[evolucao/exercicios]", err);
  }

  try {
    [volumeSemanal] = await db.execute(
      `
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
        `,
      [uid],
    );
  } catch (err) {
    console.error("[evolucao/volume]", err);
  }

  res.render("pages/evolucao", {
    user: req.session.user,
    checkins,
    workoutLogs,
    measurements,
    graficoLabels: JSON.stringify(diasSemana),
    graficoData: JSON.stringify(contPorDia),
    exerciciosExecutados,
    volumeSemanal,
    locale: req.locale || "pt",
    seo: {
      title: "Minha Evolução — FitCrew",
      canonical: "/evolucao",
      robots: "noindex, nofollow",
      description: "Acompanhe sua evolução física no FitCrew.",
    },
  });
});

// GET /api/evolucao/exercicio/:id — histórico de carga de um exercício
router.get("/api/evolucao/exercicio/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [historico] = await db.execute(
      `
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
        `,
      [userId, req.params.id],
    );
    res.json(historico);
  } catch (err) {
    console.error("[api/evolucao/exercicio]", err);
    res.status(500).json({ erro: "Erro ao buscar histórico." });
  }
});

// Meu Plano
router.get("/meu-plano", requirePlano, async (req, res) => {
  const user = req.session.user;
  try {
    const planoRows = await User.getActivePlan(user.id);
    const todosPlanos = await Plan.findAll({ activeOnly: true });
    const planoBase = planoRows || todosPlanos[1] || todosPlanos[0];

    const beneficios = (() => {
      try {
        return JSON.parse(planoBase.beneficios || "[]");
      } catch {
        return [];
      }
    })();

    const renovacao = new Date();
    renovacao.setDate(renovacao.getDate() + 30);
    const renovacaoStr = renovacao.toLocaleDateString("pt-BR");
    const tempoRestanteDias = 30;
    const progresso = 5;

    const planoAtual = {
      nome: planoBase.nome.toUpperCase(),
      descricao: planoBase.descricao,
      beneficios,
      preco: `R$ ${Number(planoBase.preco).toFixed(2).replace(".", ",")}`,
      periodo: "mês",
      renovacao: renovacaoStr,
      tempoRestanteDias,
      progresso,
    };

    const maxPreco = Math.max(...todosPlanos.map((x) => Number(x.preco)));
    const outrosPlanos = todosPlanos
      .filter((p) => p.id !== planoBase.id)
      .map((p) => {
        const ben = (() => {
          try {
            return JSON.parse(p.beneficios || "[]");
          } catch {
            return [];
          }
        })();
        return {
          nome: p.nome.toUpperCase(),
          descricao: p.descricao,
          beneficios: ben,
          preco: `R$ ${Number(p.preco).toFixed(2).replace(".", ",")}`,
          periodo: "mês",
          destaque: Number(p.preco) === maxPreco,
        };
      });

    res.render("pages/meu-plano", {
      user,
      planoAtual,
      outrosPlanos,
      seo: {
        title: "Meu Plano — FitCrew",
        canonical: "/meu-plano",
        robots: "noindex, nofollow",
        description: "Gerencie seu plano FitCrew.",
      },
    });
  } catch (err) {
    console.error("[meu-plano]", err);
    res.status(500).send("Erro ao carregar plano.");
  }
});

//Configurações (só requer login, não exige plano ativo)
router.get("/config", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT notification_interval_days, webauthn_enabled, deletion_scheduled_at, status FROM user WHERE id = ?",
      [req.session.user.id],
    );
    if (rows[0]) {
      req.session.user.notification_interval_days =
        rows[0].notification_interval_days ?? 7;
      req.session.user.webauthn_enabled = rows[0].webauthn_enabled ?? 0;
      req.session.user.deletion_scheduled_at =
        rows[0].deletion_scheduled_at || null;
      req.session.user.status = rows[0].status;
      if (
        rows[0].status === "pendente_exclusao" &&
        rows[0].deletion_scheduled_at
      ) {
        req.session.user.diasRestantesExclusao = Math.ceil(
          (new Date(rows[0].deletion_scheduled_at) - Date.now()) / 86400000,
        );
      }
    }
  } catch (_) {
    /* mantém valor da sessão se houver */
  }

  res.render("pages/config", {
    user: req.session.user,
    seo: {
      title: "Configurações — FitCrew",
      canonical: "/config",
      robots: "noindex, nofollow",
      description: "Configurações da conta FitCrew.",
    },
  });
});

//Perfil IMC
router.get("/imc-form", requirePlano, async (req, res) => {
  let ultimoImc = null;
  try {
    const [imcRows] = await db.execute(
      `SELECT * FROM imc_profile WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [req.session.user.id],
    );
    if (imcRows[0]) {
      const r = imcRows[0];
      ultimoImc = {
        peso: r.peso,
        altura: r.altura,
        imcValor: r.imc_valor,
        idade: r.idade,
        sexo: r.sexo,
        objetivo: r.objetivo,
        experiencia: r.experiencia,
        diasSemana: r.dias_semana,
        tempoPorSessao: r.tempo_por_sessao,
        localTreino: r.local_treino,
        lesoes: safeJson(r.lesoes, []),
        restricoesAlimentares: safeJson(r.restricoes_alimentares, []),
        suplementacao: safeJson(r.suplementacao, []),
        hidratacao: r.hidratacao,
        seletividade: r.seletividade,
        alimentosSeletividade: r.alimentos_seletividade || "",
      };
    }
  } catch (err) {
    console.error("[imc-form]", err);
  }
  res.render("pages/imc-form", {
    user: req.session.user,
    ultimoImc,
    primeiro: req.query.primeiro === "1",
    seo: {
      title: "Meu Perfil IMC — FitCrew",
      canonical: "/imc-form",
      robots: "noindex, nofollow",
      description: "Perfil IMC personalizado FitCrew.",
    },
  });
});

//Avaliação Corporal
router.get("/ai/avaliacao", requirePlanLevel(["black"]), async (req, res) => {
  let avaliacoes = [];
  try {
    const [rows] = await db.execute(
      `SELECT * FROM body_photo WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
      [req.session.user.id],
    );
    avaliacoes = rows.map((r) => ({
      ...r,
      analise: safeJson(r.analise_raw, null),
      data_fmt: new Date(r.created_at).toLocaleDateString("pt-BR"),
    }));
  } catch (err) {
    console.error("[ai/avaliacao GET]", err);
  }
  res.render("pages/ai-avaliacao", { user: req.session.user, avaliacoes });
});

// Atualizar e-mail nas configurações
router.post(
  "/config/atualizar-dados",
  requireAuth,
  [body("email").isEmail().withMessage("E-mail inválido.").normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const { email } = req.body;
    const user = req.session.user;
    try {
      const dup = await User.findByEmail(email);
      if (dup && dup.id !== user.id)
        return res.status(400).json({ erro: "E-mail já cadastrado." });

      await User.update(user.id, { email });
      req.session.user = { ...user, email };
      return res.json({ mensagem: "E-mail atualizado com sucesso!" });
    } catch (err) {
      console.error("[config/atualizar-dados]", err);
      return res.status(500).json({ erro: "Erro ao atualizar dados." });
    }
  },
);

// Alterar senha
router.post(
  "/config/alterar-senha",
  requireAuth,
  [
    body("senhaAtual").notEmpty().withMessage("Senha atual obrigatória."),
    body("novaSenha")
      .isLength({ min: 6 })
      .withMessage("A nova senha deve ter pelo menos 6 caracteres."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const { senhaAtual, novaSenha } = req.body;
    const user = req.session.user;
    try {
      const userRow = await User.findById(user.id);
      if (!userRow)
        return res.status(404).json({ erro: "Usuário não encontrado." });
      const ok = await bcrypt.compare(senhaAtual, userRow.senha_hash);
      if (!ok) return res.status(400).json({ erro: "Senha atual incorreta." });
      const novaHash = await bcrypt.hash(novaSenha, 10);
      await User.update(user.id, { senha_hash: novaHash });
      return res.json({ mensagem: "Senha alterada com sucesso!" });
    } catch (err) {
      console.error("[config/alterar-senha]", err);
      return res.status(500).json({ erro: "Erro ao alterar senha." });
    }
  },
);

// Alterar plano (redirecionamento para pagamento — não muda diretamente)
router.post("/config/alterar-plano", requireAuth, (req, res) => {
  return res.json({ mensagem: "Redirecionando para pagamento..." });
});

// Upload de foto de perfil
router.post(
  "/api/student/profile-photo",
  (req, res, next) => {
    if (!req.session.user)
      return res.status(401).json({ erro: "Não autorizado." });
    next();
  },
  photoUpload.single("photo"),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ erro: "Nenhum arquivo enviado." });

    const photoUrl = req.file.path; // URL do Cloudinary
    const user = req.session.user;
    try {
      await db.execute("UPDATE user SET profile_photo = ? WHERE id = ?", [
        photoUrl,
        user.id,
      ]);
      req.session.user = { ...user, profile_photo: photoUrl };
      return res.json({ mensagem: "Foto atualizada com sucesso!", photoUrl });
    } catch (err) {
      console.error("[profile-photo]", err);
      return res.status(500).json({ erro: "Erro ao salvar foto." });
    }
  },
  (err, _req, res, _next) => {
    return res.status(400).json({ erro: err.message });
  },
);

router.post("/imc-save", requireAuth, async (req, res) => {
  const {
    lesoes,
    restricoesAlimentares,
    gruposAlimentares,
    suplementacao,
    peso,
    altura,
    idade,
    sexo,
    objetivo,
    experiencia,
    diasSemana,
    tempoPorSessao,
    localTreino,
    hidratacao,
    seletividade,
    alimentosSeletividade,
  } = req.body;

  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const lesoesArr = toArr(lesoes);
  const restricArr = toArr(restricoesAlimentares);
  const gruposArr = toArr(gruposAlimentares);
  const suplArr = toArr(suplementacao);

  const alturaM = Number(altura) > 3 ? Number(altura) / 100 : Number(altura);
  const pesoN = Number(peso);
  const imc = alturaM > 0 ? (pesoN / (alturaM * alturaM)).toFixed(1) : null;

  try {
    await db.execute(
      `INSERT INTO imc_profile
             (user_id, peso, altura, imc_valor, idade, sexo, objetivo,
              experiencia, dias_semana, tempo_por_sessao, local_treino,
              lesoes, restricoes_alimentares, suplementacao, hidratacao)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        pesoN,
        alturaM,
        imc,
        Number(idade),
        sexo,
        objetivo,
        experiencia,
        Number(diasSemana),
        tempoPorSessao,
        localTreino,
        JSON.stringify(lesoesArr),
        JSON.stringify(restricArr),
        JSON.stringify(suplArr),
        hidratacao,
      ],
    );

    await db.execute(
      "UPDATE user SET peso = ?, altura = ?, imc = ?, objetivo = ?, last_imc_update = NOW() WHERE id = ?",
      [pesoN, alturaM, imc, objetivo, req.session.user.id],
    );

    req.session.user.imc = {
      peso: pesoN,
      altura,
      imcValor: imc,
      idade,
      sexo,
      objetivo,
      experiencia,
      diasSemana,
      tempoPorSessao,
      localTreino,
      lesoes: lesoesArr,
      restricoesAlimentares: restricArr,
      gruposAlimentares: gruposArr,
      suplementacao: suplArr,
      hidratacao,
      seletividade,
      alimentosSeletividade,
    };

    const isFirstLogin =
      req.session.user.first_login === 1 || req.session.user.first_login === true;

    return res.json({
      mensagem: "Perfil salvo com sucesso! Redirecionando...",
      redirect: isFirstLogin ? "/onboarding" : "/",
    });
  } catch (err) {
    console.error("[imc-save]", err);
    return res.status(500).json({ erro: "Erro ao salvar perfil." });
  }
});

// ─── F11: Onboarding primeiro acesso ─────────────────────────────────────────

router.get("/onboarding", requireAuth, async (req, res) => {
  if (!req.session.user.first_login) {
    return res.redirect("/feed");
  }

  try {
    const [[user]] = await db.execute(
      "SELECT id, nome, username, bio, profile_photo FROM user WHERE id = ?",
      [req.session.user.id],
    );

    res.render("pages/onboarding", {
      user: { ...req.session.user, ...(user || {}) },
      seo: {
        title: "Bem-vindo ao FitCrew!",
        robots: "noindex, nofollow",
        canonical: "/onboarding",
      },
    });
  } catch (err) {
    console.error("[/onboarding]", err.message);
    res.redirect("/");
  }
});

router.post("/onboarding/finalizar", requireAuth, async (req, res) => {
  try {
    await db.execute("UPDATE user SET first_login = 0 WHERE id = ?", [
      req.session.user.id,
    ]);
    req.session.user.first_login = 0;
    req.session.save(() => res.json({ ok: true }));
  } catch (err) {
    console.error("[/onboarding/finalizar]", err.message);
    res.json({ ok: false });
  }
});

// Conquistas do aluno
router.get("/conquistas", requirePlano, async (req, res) => {
  try {
    const lista = await conquistas.getConquistasUsuario(req.session.user.id);
    const totalDesbloqueadas = lista.filter((c) => c.desbloqueada).length;
    res.render("pages/conquistas", {
      user: req.session.user,
      lista,
      totalDesbloqueadas,
      total: lista.length,
      seo: {
        title: "Minhas Conquistas — FitCrew",
        canonical: "/conquistas",
        robots: "noindex, nofollow",
        description: "Suas conquistas no FitCrew.",
      },
    });
  } catch (err) {
    console.error("[conquistas]", err.message);
    res.redirect("/area-aluno");
  }
});

// Editar perfil — GET
router.get("/perfil/editar", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const [[usuario]] = await db.execute(
      "SELECT nome, username, bio, instagram_username, profile_photo, medalhas_destaque FROM user WHERE id = ?",
      [uid],
    );
    const [conquistasList] = await db.execute(
      `SELECT c.slug, c.nome, c.icone, c.tier
             FROM usuario_conquistas uc
             JOIN conquistas c ON c.id = uc.conquista_id
             WHERE uc.user_id = ?
             ORDER BY c.tier DESC, c.nome ASC`,
      [uid],
    );
    const medalhasDestaque = safeJson(usuario.medalhas_destaque, []);
    res.render("pages/editar-perfil", {
      user: req.session.user,
      usuario,
      conquistas: conquistasList,
      medalhasDestaque,
      query: req.query,
      seo: { title: "Editar Perfil — FitCrew", robots: "noindex" },
    });
  } catch (err) {
    console.error("[perfil/editar GET]", err.message);
    res.redirect("/area-aluno");
  }
});

// Editar perfil — POST
router.post(
  "/perfil/editar",
  requireAuth,
  photoUpload.single("foto"),
  async (req, res) => {
    const uid = req.session.user.id;
    const { nome, username, bio, instagram_username } = req.body;

    if (username && !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.redirect("/perfil/editar?erro=username_invalido");
    }

    try {
      if (username) {
        const [[existing]] = await db.execute(
          "SELECT id FROM user WHERE username = ? AND id != ?",
          [username, uid],
        );
        if (existing) return res.redirect("/perfil/editar?erro=username_taken");
      }

      let medalhasArr = [];
      const raw = req.body.medalhas_destaque;
      if (raw) {
        medalhasArr = (Array.isArray(raw) ? raw : [raw]).slice(0, 3);
      }

      const fields = {
        nome: nome?.trim() || req.session.user.nome,
        username: username?.trim() || null,
        bio: bio?.trim().slice(0, 150) || null,
        instagram_username: instagram_username?.replace("@", "").trim() || null,
        medalhas_destaque: JSON.stringify(medalhasArr),
      };

      if (req.file) fields.profile_photo = req.file.path;

      await User.update(uid, fields);
      req.session.user = { ...req.session.user, ...fields };

      const destino = username?.trim() || String(uid);
      res.redirect(`/perfil/${destino}?salvo=1`);
    } catch (err) {
      console.error("[perfil/editar POST]", err.message);
      res.redirect("/perfil/editar?erro=servidor");
    }
  },
  (err, _req, res, _next) => {
    console.error("[perfil/editar upload]", err.message);
    res.redirect("/perfil/editar?erro=foto_invalida");
  },
);

// Perfil público — acessível sem login
router.get("/perfil/:id", async (req, res) => {
  try {
    const param = req.params.id;
    const isNumeric = /^\d+$/.test(param);
    const [uRows] = await db.execute(
      isNumeric
        ? 'SELECT id, nome, username, bio, profile_photo, status, created_at, instagram_username FROM user WHERE id = ? AND status = "ativo"'
        : 'SELECT id, nome, username, bio, profile_photo, status, created_at, instagram_username FROM user WHERE username = ? AND status = "ativo"',
      [param],
    );
    if (!uRows.length)
      return res
        .status(404)
        .render("pages/404", { user: req.session.user || null });
    const u = uRows[0];

    const lista = await conquistas.getConquistasUsuario(u.id);
    const desbloqueadas = lista.filter((c) => c.desbloqueada);

    const [[{ totalSessoes }]] = await db.execute(
      'SELECT COUNT(*) as totalSessoes FROM treino_sessao WHERE user_id = ? AND status = "completo"',
      [u.id],
    );

    const [checkinRows] = await db.execute(
      `SELECT DATE(created_at) as dia FROM treino_checkins
             WHERE user_id = ? GROUP BY DATE(created_at) ORDER BY dia DESC LIMIT 60`,
      [u.id],
    );
    let streak = 0;
    let diaAnterior = null;
    for (const row of checkinRows) {
      const dia = new Date(row.dia);
      if (!diaAnterior) {
        streak = 1;
      } else {
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
      [u.id],
    );

    const isProprioPerfilId = !!(
      req.session.user && String(req.session.user.id) === String(u.id)
    );

    let amizadeStatus = null;
    let amizadeId = null;
    let amizadeSolicitanteId = null;
    if (req.session.user && !isProprioPerfilId) {
      const uid = req.session.user.id;
      const [fRows] = await db.execute(
        `SELECT id, status, solicitante_id FROM friendship
                 WHERE (solicitante_id = ? AND destinatario_id = ?)
                    OR (solicitante_id = ? AND destinatario_id = ?)`,
        [uid, u.id, u.id, uid],
      );
      if (fRows.length) {
        amizadeStatus = fRows[0].status;
        amizadeId = fRows[0].id;
        amizadeSolicitanteId = fRows[0].solicitante_id;
      }
    }

    const uid = req.session.user?.id;
    const convStatus =
      amizadeStatus === "aceito"
        ? "friends"
        : amizadeStatus === "pendente" &&
            String(amizadeSolicitanteId) === String(uid)
          ? "pending_sent"
          : amizadeStatus === "pendente"
            ? "pending_received"
            : "none";
    res.render("pages/perfil-publico", {
      user: req.session.user || null,
      visitante: req.session.user || null,
      isDono: isProprioPerfilId,
      perfil: u,
      conquistas: desbloqueadas,
      conquistasHero,
      totalSessoes,
      streak,
      isProprioPerfilId,
      amizadeStatus,
      amizadeId,
      amizadeSolicitanteId,
      statusAmizade: convStatus,
      fsId: amizadeId,
      perfilId: u.id,
      seo: {
        title: `Perfil de ${u.nome} — FitCrew`,
        canonical: `/perfil/${u.id}`,
        description: `Veja as conquistas de ${u.nome} no FitCrew.`,
      },
    });
  } catch (err) {
    console.error("[perfil]", err.message);
    res.status(500).redirect("/");
  }
});

// Suporte (área do aluno)
router.get("/suporte", requirePlano, (req, res) => {
  res.render("pages/suporte", {
    user: req.session.user,
    seo: {
      title: "Suporte — FitCrew",
      canonical: "/suporte",
      robots: "noindex, nofollow",
      description: "Central de suporte FitCrew.",
    },
  });
});

router.post(
  "/api/suporte/tickets",
  requireAuth,
  [
    body("assunto")
      .trim()
      .notEmpty()
      .withMessage("Assunto obrigatório.")
      .isLength({ max: 150 }),
    body("descricao")
      .trim()
      .notEmpty()
      .withMessage("Descrição obrigatória.")
      .isLength({ max: 2000 }),
    body("tipo").optional().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const { assunto, descricao, tipo } = req.body;
    const user = req.session.user;

    try {
      const [result] = await db.execute(
        `INSERT INTO ticket (user_id, assunto, mensagem, tipo, status, created_at)
             VALUES (?, ?, ?, ?, 'aberto', NOW())`,
        [user.id, assunto, descricao, tipo || "Outro"],
      );
      broadcast("new_ticket", {
        ticketId: result.insertId,
        userId: user.id,
        userName: user.nome,
        assunto,
        tipo: tipo || "Outro",
      });
      return res.json({
        ok: true,
        mensagem: "Ticket enviado com sucesso!",
        ticket: { id: result.insertId, assunto, status: "aberto" },
      });
    } catch (err) {
      console.error("[suporte/tickets]", err.message);
      return res.status(500).json({ erro: "Erro ao enviar ticket." });
    }
  },
);

router.get("/api/suporte/tickets", requireAuth, async (req, res) => {
  try {
    const [tickets] = await db.execute(
      "SELECT id, assunto, tipo, status, created_at FROM ticket WHERE user_id = ? ORDER BY created_at DESC",
      [req.session.user.id],
    );
    res.json(tickets);
  } catch (err) {
    console.error("[suporte/tickets/list]", err.message);
    res.status(500).json({ erro: "Erro ao buscar tickets." });
  }
});

router.get("/api/suporte/tickets/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [[ticket]] = await db.execute(
      "SELECT id, assunto, tipo, status FROM ticket WHERE id = ? AND user_id = ?",
      [req.params.id, userId],
    );
    if (!ticket)
      return res.status(404).json({ erro: "Ticket não encontrado." });
    const [mensagens] = await db.execute(
      "SELECT id, remetente, texto, created_at FROM ticket_mensagem WHERE ticket_id = ? ORDER BY created_at ASC",
      [ticket.id],
    );
    res.json({ ...ticket, mensagens });
  } catch (err) {
    console.error("[suporte/tickets/get]", err.message);
    res.status(500).json({ erro: "Erro ao buscar ticket." });
  }
});

router.post(
  "/api/suporte/tickets/:id/mensagem",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const { texto } = req.body;
    if (!texto?.trim())
      return res.status(400).json({ erro: "Texto obrigatório." });
    try {
      const [[ticket]] = await db.execute(
        "SELECT id FROM ticket WHERE id = ? AND user_id = ? AND status != 'fechado'",
        [req.params.id, userId],
      );
      if (!ticket)
        return res
          .status(404)
          .json({ erro: "Ticket não encontrado ou fechado." });
      const [result] = await db.execute(
        "INSERT INTO ticket_mensagem (ticket_id, remetente, texto) VALUES (?, 'usuario', ?)",
        [ticket.id, texto.trim()],
      );
      const [[msg]] = await db.execute(
        "SELECT id, remetente, texto, created_at FROM ticket_mensagem WHERE id = ?",
        [result.insertId],
      );
      const payload = {
        id: result.insertId,
        texto: texto.trim(),
        remetente: "user",
        nome: req.session.user.nome,
        created_at: new Date().toISOString(),
        ticketId: ticket.id,
      };
      broadcastTicket(ticket.id, "ticket_message", payload);
      res.json({ ...msg, criadaEm: msg.created_at });
    } catch (err) {
      console.error("[suporte/tickets/mensagem]", err.message);
      res.status(500).json({ erro: "Erro ao enviar mensagem." });
    }
  },
);

router.get("/api/suporte/tickets/:id/stream", limiterSSE, requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const ticketId = parseInt(req.params.id, 10);
  try {
    const [[ticket]] = await db.execute(
      "SELECT id FROM ticket WHERE id = ? AND user_id = ?",
      [ticketId, userId],
    );
    if (!ticket) return res.status(404).end();
  } catch {
    return res.status(500).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  addTicketClient(ticketId, res);
});

// Verifica sessão de admin GymBros para rotas administrativas
function requireAdminUser(req, res, next) {
  if (!req.session.admin) {
    return res.redirect(
      "/admin/login?next=" + encodeURIComponent(req.originalUrl),
    );
  }
  next();
}

// Admin — Suporte
router.get("/admin/suporte", requireAdminUser, async (req, res) => {
  const { status } = req.query;
  try {
    const where = status ? "WHERE t.status = ?" : "";
    const params = status ? [status] : [];
    const [lista] = await db.execute(
      `
            SELECT t.id, t.assunto, t.tipo, t.status, t.created_at,
                   u.nome AS userName, u.email AS userEmail
            FROM ticket t
            JOIN \`user\` u ON u.id = t.user_id
            ${where}
            ORDER BY t.created_at DESC
        `,
      params,
    );

    const [[{ todos }]] = await db.execute(
      "SELECT COUNT(*) as todos FROM ticket",
    );
    const [[{ resolvido }]] = await db.execute(
      "SELECT COUNT(*) as resolvido FROM ticket WHERE status='resolvido'",
    );

    let counts = { aberto: 0, em_atendimento: 0 };
    try {
      const [[result]] = await db.execute(
        "SELECT SUM(status='aberto') as aberto, SUM(status='em_atendimento') as em_atendimento FROM ticket",
      );
      counts = result;
    } catch (_) {}
    const ticketCount = (counts?.aberto || 0) + (counts?.em_atendimento || 0);

    res.render("pages/admin-suporte", {
      user: req.session.user,
      admin: req.session.user,
      lista,
      status: status || null,
      counts: {
        todos,
        aberto: counts.aberto || 0,
        em_atendimento: counts.em_atendimento || 0,
        resolvido,
      },
      page: "suporte",
      title: "Suporte",
      ticketCount,
      adminConfig: { version: "1.0.0", maintenance: false },
    });
  } catch (err) {
    console.error("[admin/suporte]", err.message);
    res.redirect("/admin-dashboard");
  }
});

router.get("/admin/suporte/:id", requireAdminUser, async (req, res) => {
  try {
    const [[ticket]] = await db.execute(
      `SELECT t.*, u.nome AS userName, u.email AS userEmail
             FROM ticket t JOIN \`user\` u ON u.id = t.user_id
             WHERE t.id = ?`,
      [req.params.id],
    );
    if (!ticket) return res.redirect("/admin/suporte");

    const ticketUser = {
      id: ticket.user_id,
      nome: ticket.userName,
      email: ticket.userEmail,
    };
    ticket.prioridade = ticket.prioridade || "normal";
    ticket.updated_at = ticket.updated_at || ticket.created_at;

    const [msgs] = await db.execute(
      "SELECT * FROM ticket_mensagem WHERE ticket_id = ? ORDER BY created_at ASC",
      [ticket.id],
    );
    const [[{ ticketCount }]] = await db.execute(
      "SELECT COUNT(*) as ticketCount FROM ticket WHERE status='aberto'",
    );

    res.render("pages/admin-suporte-chat", {
      user: ticketUser,
      admin: req.session.user,
      ticket,
      msgs,
      page: "suporte",
      title: "Suporte",
      ticketCount,
      adminConfig: { version: "1.0.0", maintenance: false },
    });
  } catch (err) {
    console.error("[admin/suporte/:id]", err.message);
    res.redirect("/admin/suporte");
  }
});

router.post(
  "/api/admin/suporte/tickets/:id/mensagem",
  requireAdminUser,
  async (req, res) => {
    const { texto } = req.body;
    if (!texto?.trim())
      return res.status(400).json({ erro: "Texto obrigatório." });
    try {
      const [[ticket]] = await db.execute(
        "SELECT id FROM ticket WHERE id = ? AND status != 'fechado'",
        [req.params.id],
      );
      if (!ticket)
        return res.status(404).json({ erro: "Ticket não encontrado." });

      const [result] = await db.execute(
        "INSERT INTO ticket_mensagem (ticket_id, remetente, texto) VALUES (?, 'admin', ?)",
        [ticket.id, texto.trim()],
      );
      const [[msg]] = await db.execute(
        "SELECT * FROM ticket_mensagem WHERE id = ?",
        [result.insertId],
      );

      broadcastTicket(parseInt(ticket.id), "ticket_message", {
        id: result.insertId,
        texto: texto.trim(),
        remetente: "admin",
        nome: "Admin",
        created_at: new Date().toISOString(),
        ticketId: parseInt(ticket.id),
      });
      res.json({ ...msg, criadaEm: msg.created_at });
    } catch (err) {
      console.error("[api/admin/suporte/mensagem]", err.message);
      res.status(500).json({ erro: "Erro ao enviar mensagem." });
    }
  },
);

router.get(
  "/api/admin/suporte/tickets/:id/stream",
  limiterSSE,
  requireAdminUser,
  (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");
    const ticketId = parseInt(req.params.id);
    addTicketClient(ticketId, res);
    const ping = setInterval(() => res.write(":ping\n\n"), 20000);
    req.on("close", () => clearInterval(ping));
  },
);

router.put(
  "/api/admin/suporte/tickets/:id/status",
  requireAdminUser,
  async (req, res) => {
    const { status } = req.body;
    const validos = ["aberto", "em_atendimento", "resolvido", "fechado"];
    if (!validos.includes(status))
      return res.status(400).json({ erro: "Status inválido." });
    try {
      await db.execute("UPDATE ticket SET status = ? WHERE id = ?", [
        status,
        req.params.id,
      ]);
      broadcast("ticket_update", { ticketId: req.params.id, status });
      res.json({ ok: true });
    } catch (err) {
      console.error("[api/admin/suporte/status]", err.message);
      res.status(500).json({ erro: "Erro ao atualizar status." });
    }
  },
);

//Administração
router.get("/admin-dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-dashboard", {
    user: req.session.user,
    admin: req.session.user,
    page: "dashboard",
    title: "Dashboard",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Checkin
router.get("/admin-checkins", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-checkins", {
    user: req.session.user,
    admin: req.session.user,
    page: "checkins",
    title: "Check-ins",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Admin Configurações
router.get("/admin-configuracoes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-configuracoes", {
    user: req.session.user,
    admin: req.session.user,
    page: "configuracoes",
    title: "Configurações",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Login
router.get("/admin-login", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-login", { user: req.session.user });
});

//Administração Academias
router.get("/admin-academias", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-academias", {
    user: req.session.user,
    admin: req.session.user,
    page: "academias",
    title: "Academias",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Inadimplentes
router.get("/admin-financeiro-inadimplentes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-financeiro-inadimplentes", {
    user: req.session.user,
    admin: req.session.user,
    page: "financeiro",
    title: "Financeiro",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Receitas
router.get("/admin-financeiro-receitas", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-financeiro-receitas", {
    user: req.session.user,
    admin: req.session.user,
    page: "financeiro",
    title: "Financeiro",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Financeiro
router.get("/admin-financeiro", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-financeiro", {
    user: req.session.user,
    admin: req.session.user,
    page: "financeiro",
    title: "Financeiro",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Notificações
router.get("/admin-notificacoes", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-notificacoes", {
    user: req.session.user,
    admin: req.session.user,
    page: "notificacoes",
    title: "Notificações",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Planos
router.get("/admin-planos", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-planos", {
    user: req.session.user,
    admin: req.session.user,
    page: "planos",
    title: "Planos",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Relatórios
router.get("/admin-relatorios", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-relatorios", {
    user: req.session.user,
    admin: req.session.user,
    page: "relatorios",
    title: "Relatórios",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Usuário Perfil
router.get("/admin-usuario-perfil", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-usuario-perfil", {
    user: req.session.user,
    admin: req.session.user,
    page: "usuarios",
    title: "Usuários",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

//Administração Usuários
router.get("/admin-usuarios", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("pages/admin-usuarios", {
    user: req.session.user,
    admin: req.session.user,
    page: "usuarios",
    title: "Usuários",
    adminConfig: { version: "1.0.0", maintenance: false },
    ticketCount: 0,
  });
});

// Logout — POST evita logout acidental por crawler/prefetch
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error(err);
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

// Redireciona GET /logout para home (crawlers, bookmarks antigos)
router.get("/logout", (req, res) => {
  res.redirect("/");
});

// ====================
// ROTAS POST
// ====================

// Registro
router.post(
  "/register",
  [
    body("nome")
      .trim()
      .notEmpty()
      .withMessage("Nome obrigatório.")
      .isLength({ min: 3 })
      .withMessage("Nome muito curto."),
    body("cpf").custom((value) => {
      if (!validarCPF(value)) throw new Error("CPF inválido.");
      return true;
    }),
    body("email").isEmail().withMessage("E-mail inválido."),
    body("cep")
      .matches(/^\d{8}$/)
      .withMessage("CEP deve ter 8 números."),
    body("password")
      .isLength({ min: 6 })
      .withMessage("A senha deve ter pelo menos 6 caracteres."),
    body("confirmPassword").custom((value, { req }) => {
      if (value !== req.body.password)
        throw new Error("As senhas não coincidem!");
      return true;
    }),
    body("terms")
      .equals("on")
      .withMessage("Você precisa aceitar os termos de uso."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const {
      nome,
      email,
      cep,
      password,
      logradouro,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
    } = req.body;
    const cpf = req.body.cpf.replace(/\D/g, "");

    try {
      if (await User.findByCpf(cpf))
        return res
          .status(400)
          .json({ erros: [{ param: "cpf", msg: "CPF já cadastrado." }] });
      if (await User.findByEmail(email))
        return res
          .status(400)
          .json({ erros: [{ param: "email", msg: "E-mail já cadastrado." }] });

      const senha_hash = await bcrypt.hash(password, 10);
      await User.create({
        nome,
        cpf,
        email,
        senha_hash,
        cep,
        logradouro,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
      });
      return res
        .status(200)
        .json({
          mensagem:
            "Cadastro realizado com sucesso! Redirecionando para o login...",
        });
    } catch (err) {
      console.error("[register]", err);
      return res
        .status(500)
        .json({ erros: [{ msg: "Erro interno ao cadastrar." }] });
    }
  },
);

// Login
router.post(
  "/login",
  limiterLogin,
  [
    body("username").trim().notEmpty().withMessage("Usuário obrigatório."),
    body("password").notEmpty().withMessage("Senha obrigatória."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ erros: errors.array() });

    const { username, password, redirect: redirectTo } = req.body;
    const identifier = username.trim();
    const cpfNorm = identifier.replace(/\D/g, "");

    try {
      const user = await User.findActiveByIdentifier(identifier);
      if (!user || !(await bcrypt.compare(password, user.senha_hash))) {
        await db
          .execute(
            "INSERT INTO login_attempt (identificador, ip, sucesso) VALUES (?, ?, 0)",
            [identifier, req.ip],
          )
          .catch(() => {});
        return res
          .status(401)
          .json({
            erros: [{ param: "password", msg: "Usuário ou senha incorretos." }],
          });
      }

      const [plano, imcRow, avalRow] = await Promise.all([
        User.getActivePlan(user.id),
        ImcProfile.findLatestByUser(user.id),
        BodyPhoto.findLatestByUser(user.id),
      ]);

      const imcData = imcRow
        ? {
            peso: imcRow.peso,
            altura: imcRow.altura,
            imcValor: imcRow.imc_valor,
            idade: imcRow.idade,
            sexo: imcRow.sexo,
            objetivo: imcRow.objetivo,
            experiencia: imcRow.experiencia,
            diasSemana: imcRow.dias_semana,
            tempoPorSessao: imcRow.tempo_por_sessao,
            localTreino: imcRow.local_treino,
            lesoes: safeJson(imcRow.lesoes, []),
            restricoesAlimentares: safeJson(imcRow.restricoes_alimentares, []),
            suplementacao: safeJson(imcRow.suplementacao, []),
            hidratacao: imcRow.hidratacao,
            seletividade: imcRow.seletividade,
            alimentosSeletividade: imcRow.alimentos_seletividade,
          }
        : null;

      const avalRaw = avalRow ? safeJson(avalRow.analise_raw, null) : null;
      const avalData = avalRaw
        ? {
            ...avalRaw,
            data: new Date(avalRow.created_at).toLocaleDateString("pt-BR"),
          }
        : null;

      const diasRestantesExclusao =
        user.status === "pendente_exclusao" && user.deletion_scheduled_at
          ? Math.ceil(
              (new Date(user.deletion_scheduled_at) - Date.now()) / 86400000,
            )
          : null;

      req.session.user = {
        id: user.id,
        nome: user.nome,
        email: user.email,
        cpf: user.cpf,
        username: user.username || null,
        bio: user.bio || null,
        first_login: user.first_login,
        plano: plano?.nome || null,
        planoId: plano?.id || null,
        planoSlug: plano?.slug || null,
        profile_photo: user.profile_photo || null,
        status: user.status,
        deletion_scheduled_at: user.deletion_scheduled_at || null,
        diasRestantesExclusao,
        role: user.role || "aluno",
        status_conta: user.status_conta || "ativo",
        suspenso_ate: user.suspenso_ate || null,
        motivo_suspensao: user.motivo_suspensao || null,
        webauthn_enabled: user.webauthn_enabled || 0,
        last_imc_update: user.last_imc_update || null,
        last_avaliacao_update: user.last_avaliacao_update || null,
        notification_interval_days: user.notification_interval_days || 7,
        imc: imcData,
        avaliacaoCorporal: avalData,
      };

      await db
        .execute(
          "INSERT INTO login_attempt (identificador, ip, sucesso) VALUES (?, ?, 1)",
          [identifier, req.ip],
        )
        .catch(() => {});

      broadcast("user_online", {
        id: user.id,
        nome: user.nome,
        email: user.email,
      });

      const safeRedirect =
        redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")
          ? redirectTo
          : "/feed";
      req.session.save((err) => {
        if (err) {
          console.error("[login] session save error:", err);
          return res
            .status(500)
            .json({ erros: [{ msg: "Erro ao salvar sessão." }] });
        }
        return res
          .status(200)
          .json({
            mensagem: "Login realizado com sucesso! Redirecionando...",
            redirect: safeRedirect,
          });
      });
    } catch (err) {
      console.error("[login]", err);
      return res
        .status(500)
        .json({ erros: [{ msg: "Erro interno ao autenticar." }] });
    }
  },
);

// ====================
// SITEMAP
// ====================
router.get("/sitemap.xml", (req, res) => {
  res.header("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://fitcrew.net/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://fitcrew.net/planos</loc>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://fitcrew.net/register</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://fitcrew.net/about</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://fitcrew.net/faq</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://fitcrew.net/academias</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>`);
});

// ====================
// ARQUIVOS ESTÁTICOS
// ====================
router.get("/js/carrossel.js", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/js/carrossel.js")),
);
router.get("/js/header.js", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/js/header.js")),
);
router.get("/js/forms.js", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/js/forms.js")),
);
router.get("/js/area-aluno.js", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/js/area-aluno.js")),
);

// ====================
// NUTRIÇÃO
// ====================

// ── Helpers de nutrição ────────────────────────────────────────────────────────

async function recalcularLog(logId) {
  await db.execute(
    `
        UPDATE nutrition_log nl
        SET
            kcal       = (SELECT COALESCE(SUM(kcal), 0)       FROM nutrition_item WHERE log_id = ?),
            proteina_g = (SELECT COALESCE(SUM(proteina_g), 0) FROM nutrition_item WHERE log_id = ?),
            carbs_g    = (SELECT COALESCE(SUM(carbs_g), 0)    FROM nutrition_item WHERE log_id = ?),
            gordura_g  = (SELECT COALESCE(SUM(gordura_g), 0)  FROM nutrition_item WHERE log_id = ?),
            fibra_g    = (SELECT COALESCE(SUM(fibra_g), 0)    FROM nutrition_item WHERE log_id = ?)
        WHERE nl.id = ?
    `,
    [logId, logId, logId, logId, logId, logId],
  );
}

// ── GET /api/nutricao/buscar?q=frango&lang=pt ─────────────────────────────────
router.get("/api/nutricao/buscar", limiterBusca, requireAuth, async (req, res) => {
  const query = (req.query.q || "").trim();
  const lang = ["pt", "en", "es"].includes(req.query.lang)
    ? req.query.lang
    : ["pt", "en", "es"].includes(req.cookies?.gymbros_lang)
      ? req.cookies.gymbros_lang
      : "pt";
  if (query.length < 2) return res.json([]);
  try {
    const resultados = await searchAlimento(query, lang);
    res.json(resultados);
  } catch (err) {
    console.error("[nutricao/buscar]", err.message);
    res.status(500).json({ erro: "Erro na busca." });
  }
});

// ── POST /api/nutricao/refeicao — criar/obter log da refeição do dia ──────────
router.post("/api/nutricao/refeicao", requireAuth, async (req, res) => {
  const {
    refeicao_tipo,
    data: dataCliente,
    horario: horarioCliente,
  } = req.body;
  const uid = req.session.user.id;
  const hoje =
    dataCliente ||
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const hora =
    horarioCliente ||
    new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "America/Sao_Paulo",
    });

  const tiposValidos = ["cafe", "almoco", "jantar", "lanche", "outro"];
  if (!tiposValidos.includes(refeicao_tipo)) {
    return res.status(400).json({ erro: "Tipo de refeição inválido." });
  }

  try {
    let [[log]] = await db.execute(
      "SELECT id FROM nutrition_log WHERE user_id = ? AND data = ? AND refeicao_tipo = ?",
      [uid, hoje, refeicao_tipo],
    );
    if (!log) {
      const nomes = {
        cafe: "Café da manhã",
        almoco: "Almoço",
        jantar: "Jantar",
        lanche: "Lanche",
        outro: "Outro",
      };
      const refeicaoEnum = {
        cafe: "cafe",
        almoco: "almoco",
        jantar: "jantar",
        lanche: "lanche_tarde",
        outro: "almoco",
      };
      const [result] = await db.execute(
        "INSERT INTO nutrition_log (user_id, descricao, refeicao, refeicao_tipo, registrado_em, horario, kcal, proteina_g, carbs_g, gordura_g, fibra_g) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)",
        [
          uid,
          nomes[refeicao_tipo] || "Refeição",
          refeicaoEnum[refeicao_tipo] || "almoco",
          refeicao_tipo,
          `${hoje} ${hora}`,
          hora,
        ],
      );
      log = { id: result.insertId };
    }
    res.json({ ok: true, log_id: log.id });
  } catch (err) {
    console.error("[nutricao/refeicao]", err.message);
    res.status(500).json({ erro: "Erro ao criar refeição." });
  }
});

// ── POST /api/nutricao/item — adicionar item a uma refeição ───────────────────
router.post("/api/nutricao/item", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const {
    log_id,
    alimento_nome,
    quantidade_g,
    kcal_100g,
    proteina_100g,
    carbs_100g,
    gordura_100g,
    fibra_100g,
    fonte,
    fonte_id,
  } = req.body;

  if (!log_id || !alimento_nome || !quantidade_g) {
    return res.status(400).json({ erro: "Campos obrigatórios ausentes." });
  }

  const [[log]] = await db.execute(
    "SELECT id FROM nutrition_log WHERE id = ? AND user_id = ?",
    [log_id, uid],
  );
  if (!log) return res.status(404).json({ erro: "Refeição não encontrada." });

  const fator = Number(quantidade_g) / 100;
  const kcal = Math.round(Number(kcal_100g) * fator * 10) / 10;
  const prot = Math.round(Number(proteina_100g) * fator * 10) / 10;
  const carbs = Math.round(Number(carbs_100g) * fator * 10) / 10;
  const gord = Math.round(Number(gordura_100g) * fator * 10) / 10;
  const fibra = Math.round(Number(fibra_100g) * fator * 10) / 10;

  try {
    const [result] = await db.execute(
      "INSERT INTO nutrition_item (log_id, alimento_nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g, fonte, fonte_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        log_id,
        alimento_nome.trim(),
        Number(quantidade_g),
        kcal,
        prot,
        carbs,
        gord,
        fibra,
        fonte || "manual",
        fonte_id || null,
      ],
    );
    await recalcularLog(log_id);
    const [[item]] = await db.execute(
      "SELECT * FROM nutrition_item WHERE id = ?",
      [result.insertId],
    );
    res.status(201).json({ ok: true, item });
  } catch (err) {
    console.error("[nutricao/item]", err.message);
    res.status(500).json({ erro: "Erro ao adicionar item." });
  }
});

// ── DELETE /api/nutricao/item/:id ─────────────────────────────────────────────
router.delete("/api/nutricao/item/:id", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const [[item]] = await db.execute(
      `SELECT ni.id, ni.log_id FROM nutrition_item ni
             JOIN nutrition_log nl ON nl.id = ni.log_id
             WHERE ni.id = ? AND nl.user_id = ?`,
      [req.params.id, uid],
    );
    if (!item) return res.status(404).json({ erro: "Item não encontrado." });

    await db.execute("DELETE FROM nutrition_item WHERE id = ?", [item.id]);
    await recalcularLog(item.log_id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[nutricao/item/delete]", err.message);
    res.status(500).json({ erro: "Erro ao remover item." });
  }
});

// ── GET /api/nutricao/itens/:logId ───────────────────────────────────────────
router.get("/api/nutricao/itens/:logId", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const [[log]] = await db.execute(
      "SELECT id FROM nutrition_log WHERE id = ? AND user_id = ?",
      [req.params.logId, uid],
    );
    if (!log) return res.status(404).json({ erro: "Log não encontrado." });
    const [itens] = await db.execute(
      "SELECT id, alimento_nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g FROM nutrition_item WHERE log_id = ? ORDER BY id ASC",
      [req.params.logId],
    );
    res.json({ itens });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar itens." });
  }
});

// ── GET /api/nutricao/historico?page=1 ───────────────────────────────────────
router.get("/api/nutricao/historico", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limite = 10;
  const offset = (page - 1) * limite;

  try {
    const [dias] = await db.execute(
      `
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
        `,
      [uid],
    );

    for (const dia of dias) {
      const dataStr = new Date(dia.data).toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const [logs] = await db.execute(
        `SELECT id, refeicao_tipo, horario, kcal
                 FROM nutrition_log
                 WHERE user_id = ? AND data = ?
                 ORDER BY horario ASC`,
        [uid, dataStr],
      );
      for (const log of logs) {
        const [itens] = await db.execute(
          `SELECT id, alimento_nome, quantidade_g, kcal, proteina_g
                     FROM nutrition_item WHERE log_id = ?`,
          [log.id],
        );
        log.itens = itens;
      }
      dia.logs = logs.filter((l) => l.itens.length > 0);
    }

    const [[{ total }]] = await db.execute(
      "SELECT COUNT(DISTINCT data) as total FROM nutrition_log WHERE user_id = ?",
      [uid],
    );

    res.json({
      dias,
      total: Number(total),
      page,
      totalPages: Math.ceil(Number(total) / limite),
    });
  } catch (err) {
    console.error("[nutricao/historico]", err.message);
    res.status(500).json({ erro: "Erro ao buscar histórico." });
  }
});

router.get("/nutricao", requirePlano, async (req, res) => {
  const uid = req.session.user.id;
  let imc = null;
  let metas = {
    kcal: 2000,
    proteina: 120,
    carbs: 250,
    gordura: 65,
    fibra: 25,
    agua: 2500,
    calculado: false,
  };
  let registrosHoje = [],
    aderenciaSemanal = [];
  let objetivoAtual = null;

  try {
    const [imcRows] = await db.execute(
      "SELECT * FROM imc_profile WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      [uid],
    );
    imc = imcRows[0] || null;
  } catch (err) {
    console.error("[nutricao/imc]", err);
  }

  try {
    const [[userRow]] = await db.execute(
      "SELECT nutricao_objetivo FROM `user` WHERE id = ?",
      [uid],
    );
    objetivoAtual = userRow?.nutricao_objetivo || null;
  } catch (_) {}

  const objOverride =
    objetivoAtual === "cutting"
      ? "cutting"
      : objetivoAtual === "bulking"
        ? "bulking"
        : objetivoAtual === "manutencao"
          ? "manutencao"
          : null;
  const imcComObjetivo = imc
    ? { ...imc, objetivo: objOverride || imc.objetivo || "" }
    : null;
  if (imcComObjetivo) metas = calcularMetas(imcComObjetivo);

  try {
    const dataHoje = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Sao_Paulo",
    });
    const [rows] = await db.execute(
      `SELECT * FROM nutrition_log
             WHERE user_id = ? AND data = ? AND refeicao != 'agua'
             ORDER BY refeicao_tipo ASC, registrado_em ASC`,
      [uid, dataHoje],
    );
    for (const r of rows) {
      const [itens] = await db.execute(
        `SELECT id, alimento_nome AS nome, quantidade_g, kcal, proteina_g, carbs_g, gordura_g, fibra_g, fonte
                 FROM nutrition_item WHERE log_id = ?`,
        [r.id],
      );
      r.itens = itens;
    }
    registrosHoje = rows;
  } catch (err) {
    console.error("[nutricao/logs]", err);
  }

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
      [uid],
    );
  } catch (err) {
    console.error("[nutricao/aderencia]", err);
  }

  const totaisHoje = registrosHoje.reduce(
    (acc, r) => ({
      kcal: acc.kcal + (Number(r.kcal) || 0),
      proteina: acc.proteina + (Number(r.proteina_g) || 0),
      carbs: acc.carbs + (Number(r.carbs_g) || 0),
      gordura: acc.gordura + (Number(r.gordura_g) || 0),
      fibra: acc.fibra + (Number(r.fibra_g) || 0),
    }),
    { kcal: 0, proteina: 0, carbs: 0, gordura: 0, fibra: 0 },
  );

  const obj = objOverride || (imc?.objetivo || "").toLowerCase();
  let objetivoLabel = "Manutenção";
  if (
    obj === "cutting" ||
    obj.includes("perder") ||
    obj.includes("emagrecer") ||
    obj.includes("cutting") ||
    obj.includes("definir")
  )
    objetivoLabel = "Cutting";
  else if (
    obj === "bulking" ||
    obj.includes("ganhar") ||
    obj.includes("massa") ||
    obj.includes("bulking") ||
    obj.includes("hipertrofia")
  )
    objetivoLabel = "Bulking";

  res.render("pages/nutricao", {
    user: req.session.user,
    imc,
    metas,
    registrosHoje,
    totaisHoje,
    aderenciaSemanal,
    objetivoLabel,
    objetivoAtual: objetivoAtual || "manutencao",
    seo: {
      title: "Nutrição — FitCrew",
      canonical: "/nutricao",
      robots: "noindex, nofollow",
      description: "Acompanhe sua nutrição diária no FitCrew.",
    },
  });
});

router.post("/api/nutricao/objetivo", requirePlano, async (req, res) => {
  const uid = req.session.user.id;
  const { objetivo } = req.body;
  const valid = ["cutting", "manutencao", "bulking"];
  if (!valid.includes(objetivo))
    return res.status(400).json({ erro: "Objetivo inválido." });
  try {
    await db.execute("UPDATE `user` SET nutricao_objetivo = ? WHERE id = ?", [
      objetivo,
      uid,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[api/nutricao/objetivo]", err);
    res.status(500).json({ erro: "Erro ao salvar objetivo." });
  }
});

router.post("/api/nutricao/registrar", requirePlano, async (req, res) => {
  const uid = req.session.user.id;
  const {
    refeicao,
    refeicao_tipo,
    kcal,
    proteina_g,
    carbs_g,
    gordura_g,
    fibra_g,
    foto_url,
    data: dataCliente,
    horario: horarioCliente,
  } = req.body;

  if (!refeicao || kcal === undefined || kcal === null || kcal === "") {
    return res
      .status(400)
      .json({ erro: "Nome da refeição e calorias são obrigatórios." });
  }

  const tiposValidos = ["cafe", "almoco", "jantar", "lanche", "outro"];
  const tipo = tiposValidos.includes(refeicao_tipo) ? refeicao_tipo : "outro";

  try {
    const [result] = await db.execute(
      `INSERT INTO nutrition_log (user_id, refeicao, refeicao_tipo, registrado_em, kcal, proteina_g, carbs_g, gordura_g, fibra_g, foto_url, horario)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        String(refeicao).trim().slice(0, 255),
        tipo,
        dataCliente && horarioCliente
          ? `${dataCliente} ${horarioCliente}`
          : null,
        Math.round(Number(kcal) || 0),
        Number(proteina_g) || 0,
        Number(carbs_g) || 0,
        Number(gordura_g) || 0,
        Number(fibra_g) || 0,
        foto_url || null,
        horarioCliente || null,
      ],
    );
    const [[novoLog]] = await db.execute(
      "SELECT * FROM nutrition_log WHERE id = ?",
      [result.insertId],
    );
    res.json({ ok: true, log: novoLog });
  } catch (err) {
    console.error("[api/nutricao/registrar]", err);
    res.status(500).json({ erro: "Erro ao registrar alimento." });
  }
});

router.post(
  "/api/nutricao/foto",
  requirePlano,
  fotoNutricaoUpload.single("foto"),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ erro: "Nenhuma foto enviada." });

    const fotoUrl = req.file.path || req.file.secure_url;
    const fallback = {
      alimentos: [
        {
          nome: "Refeição não identificada",
          quantidade_estimada: "porção",
          peso_estimado_g: 0,
          kcal: 0,
          proteina_g: 0,
          carbs_g: 0,
          gordura_g: 0,
          fibra_g: 0,
          confianca: "baixa",
        },
      ],
      observacao: "Não foi possível identificar os alimentos.",
    };

    try {
      // Gemini recebe a imagem como bytes (inlineData), não por URL — baixa
      // do Cloudinary e detecta o mimeType real pelo header da resposta em
      // vez de adivinhar pela extensão da URL (mais confiável p/ .webp etc.).
      const imgResp = await fetch(fotoUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      const mimeType = imgResp.headers.get("content-type") || "image/jpeg";
      const imgBase64 = imgBuffer.toString("base64");

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Você é um nutricionista especialista em reconhecimento visual de alimentos.
Analise esta imagem e identifique TODOS os alimentos visíveis.

Responda APENAS com JSON válido, sem texto adicional, sem markdown, sem backticks:
{
  "alimentos": [
    {
      "nome": "nome do alimento em português",
      "quantidade_estimada": "descrição visual (ex: 1 banana média, 200ml, 1 fatia)",
      "peso_estimado_g": 150,
      "kcal": 89,
      "proteina_g": 1.1,
      "carbs_g": 23,
      "gordura_g": 0.3,
      "fibra_g": 2.6,
      "confianca": "alta|media|baixa"
    }
  ],
  "observacao": "texto opcional sobre incertezas"
}

Se for um prato com múltiplos ingredientes, liste cada um separadamente.
Se não conseguir identificar nada, retorne {"alimentos": [], "observacao": "motivo"}.
Seja conservador nas estimativas de macros.`,
              },
              { inlineData: { mimeType, data: imgBase64 } },
            ],
          },
        ],
      });

      const raw = response.text?.trim() || "";
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      let analise;
      try {
        analise = JSON.parse(cleaned);
        if (!Array.isArray(analise.alimentos)) {
          console.error(
            "[nutricao/foto] resposta do Gemini sem .alimentos[] válido:",
            cleaned,
          );
          analise = fallback;
        }
      } catch {
        console.error(
          "[nutricao/foto] não foi possível parsear JSON do Gemini:",
          cleaned,
        );
        analise = fallback;
      }

      res.json({ ok: true, fotoUrl, analise });
    } catch (err) {
      console.error("[nutricao/foto] erro Gemini:", err.message);
      res.json({ ok: true, fotoUrl, analise: fallback });
    }
  },
);

// ── POST /api/nutricao/barcode — busca produto por código de barras ──────────
// Cosmos (base brasileira) só devolve nome/marca/foto, nunca informação
// nutricional — confirmado testando com produtos reais. Por isso os macros
// vêm sempre do OpenFoodFacts; Cosmos só melhora nome/marca/foto quando acha.
router.post("/api/nutricao/barcode", requireAuth, async (req, res) => {
  const codigo = String(req.body?.codigo || "").replace(/\D/g, "");
  if (codigo.length < 6 || codigo.length > 14) {
    return res.json({ ok: false, erro: "Código de barras inválido." });
  }

  const [cosmosProduto, offProduto] = await Promise.all([
    buscarCosmos(codigo),
    buscarOpenFoodFacts(codigo),
  ]);

  if (!offProduto) {
    return res.json({
      ok: false,
      erro: cosmosProduto
        ? "Produto encontrado, mas sem dados nutricionais disponíveis."
        : "Produto não encontrado.",
    });
  }

  res.json({
    ok: true,
    produto: {
      codigo,
      nome: cosmosProduto?.nome || offProduto.nome,
      marca: cosmosProduto?.marca || offProduto.marca,
      porcao_g: offProduto.porcao_g,
      foto_url: cosmosProduto?.foto_url || offProduto.foto_url,
      por100g: offProduto.por100g,
    },
  });
});

async function buscarCosmos(codigo) {
  if (!process.env.COSMOS_TOKEN) return null;
  try {
    const r = await fetch(`https://api.cosmos.bluesoft.com.br/gtins/${codigo}`, {
      headers: {
        "X-Cosmos-Token": process.env.COSMOS_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": "FitCrew/1.0 (fitcrew.net)",
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data?.description) return null;
    return {
      nome: data.description,
      marca: data.brand?.name || "",
      foto_url: data.thumbnail || null,
    };
  } catch (err) {
    console.error("[barcode/cosmos]", err.message);
    return null;
  }
}

async function buscarOpenFoodFacts(codigo) {
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v0/product/${codigo}.json`,
      { headers: { "User-Agent": "FitCrew/1.0 (fitcrew.net)" } },
    );
    const data = await r.json();
    if (Number(data.status) !== 1 || !data.product) return null;

    const p = data.product;
    const n = p.nutriments || {};
    return {
      nome: p.product_name_pt || p.product_name || "Produto",
      marca: p.brands || "",
      porcao_g: parseFloat(p.serving_size) || 100,
      foto_url: p.image_front_thumb_url || p.image_thumb_url || null,
      por100g: {
        kcal: n["energy-kcal_100g"] || (n["energy_100g"] || 0) / 4.184 || 0,
        proteina: n["proteins_100g"] || 0,
        carbs: n["carbohydrates_100g"] || 0,
        gordura: n["fat_100g"] || 0,
        fibra: n["fiber_100g"] || 0,
      },
    };
  } catch (err) {
    console.error("[barcode/openfoodfacts]", err.message);
    return null;
  }
}

router.delete("/api/nutricao/:id", requirePlano, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const [result] = await db.execute(
      "DELETE FROM nutrition_log WHERE id = ? AND user_id = ?",
      [req.params.id, uid],
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ erro: "Registro não encontrado." });
    res.json({ ok: true });
  } catch (err) {
    console.error("[api/nutricao/delete]", err);
    res.status(500).json({ erro: "Erro ao excluir registro." });
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — login biométrico (pré-autenticação, sem requireAuth)
// ══════════════════════════════════════════════════════════════════

router.get("/api/webauthn/login/opcoes", async (req, res) => {
  const { identifier } = req.query;
  if (!identifier)
    return res.status(400).json({ erro: "Identificador obrigatório." });
  try {
    const user = await User.findActiveByIdentifier(identifier.trim());
    if (!user?.webauthn_enabled || !user?.webauthn_credential_id) {
      return res
        .status(400)
        .json({ erro: "Biometria não cadastrada para este usuário." });
    }
    const opcoes = await webauthn.gerarOpcoesAutenticacao(user);
    req.session.webauthnChallenge = opcoes.challenge;
    req.session.webauthnLoginUserId = user.id;
    res.json(opcoes);
  } catch (err) {
    console.error("[webauthn/login/opcoes]", err.message);
    res.status(500).json({ erro: "Erro ao gerar opções de login." });
  }
});

router.post("/api/webauthn/login/verificar", async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  const userId = req.session.webauthnLoginUserId;
  if (!expectedChallenge || !userId)
    return res.status(400).json({ erro: "Sessão expirada. Tente novamente." });

  try {
    const [[userRow]] = await db.execute(
      "SELECT * FROM user WHERE id=? AND webauthn_enabled=1 AND status IN ('ativo','pendente_exclusao')",
      [userId],
    );
    if (!userRow)
      return res.status(400).json({ erro: "Usuário não encontrado." });
    if (userRow.cpf_enc) userRow.cpf = decryptCpf(userRow.cpf_enc);

    const verificacao = await webauthn.verificarAutenticacao(
      req.body,
      expectedChallenge,
      userRow.webauthn_public_key,
      userRow.webauthn_counter,
    );
    if (!verificacao.verified)
      return res.status(400).json({ erro: "Autenticação biométrica falhou." });

    await db.execute("UPDATE user SET webauthn_counter=? WHERE id=?", [
      verificacao.authenticationInfo.newCounter,
      userId,
    ]);

    req.session.webauthnChallenge = null;
    req.session.webauthnLoginUserId = null;

    const [plano, imcRow, avalRow] = await Promise.all([
      User.getActivePlan(userRow.id),
      ImcProfile.findLatestByUser(userRow.id),
      BodyPhoto.findLatestByUser(userRow.id),
    ]);

    const imcData = imcRow
      ? {
          peso: imcRow.peso,
          altura: imcRow.altura,
          imcValor: imcRow.imc_valor,
          idade: imcRow.idade,
          sexo: imcRow.sexo,
          objetivo: imcRow.objetivo,
          experiencia: imcRow.experiencia,
          diasSemana: imcRow.dias_semana,
          tempoPorSessao: imcRow.tempo_por_sessao,
          localTreino: imcRow.local_treino,
          lesoes: safeJson(imcRow.lesoes, []),
          restricoesAlimentares: safeJson(imcRow.restricoes_alimentares, []),
          suplementacao: safeJson(imcRow.suplementacao, []),
          hidratacao: imcRow.hidratacao,
          seletividade: imcRow.seletividade,
          alimentosSeletividade: imcRow.alimentos_seletividade,
        }
      : null;

    const avalRaw = avalRow ? safeJson(avalRow.analise_raw, null) : null;
    const avalData = avalRaw
      ? {
          ...avalRaw,
          data: new Date(avalRow.created_at).toLocaleDateString("pt-BR"),
        }
      : null;

    const diasRestantesExclusao =
      userRow.status === "pendente_exclusao" && userRow.deletion_scheduled_at
        ? Math.ceil(
            (new Date(userRow.deletion_scheduled_at) - Date.now()) / 86400000,
          )
        : null;

    req.session.user = {
      id: userRow.id,
      nome: userRow.nome,
      email: userRow.email,
      cpf: userRow.cpf,
      username: userRow.username || null,
      bio: userRow.bio || null,
      first_login: userRow.first_login,
      plano: plano?.nome || null,
      planoId: plano?.id || null,
      planoSlug: plano?.slug || null,
      profile_photo: userRow.profile_photo || null,
      status: userRow.status,
      deletion_scheduled_at: userRow.deletion_scheduled_at || null,
      diasRestantesExclusao,
      webauthn_enabled: userRow.webauthn_enabled || 0,
      last_imc_update: userRow.last_imc_update || null,
      last_avaliacao_update: userRow.last_avaliacao_update || null,
      notification_interval_days: userRow.notification_interval_days || 7,
      imc: imcData,
      avaliacaoCorporal: avalData,
    };

    broadcast("user_online", {
      id: userRow.id,
      nome: userRow.nome,
      email: userRow.email,
    });

    req.session.save((err) => {
      if (err) return res.status(500).json({ erro: "Erro ao salvar sessão." });
      res.json({ ok: true, redirect: "/area-aluno" });
    });
  } catch (err) {
    console.error("[webauthn/login/verificar]", err.message);
    res
      .status(500)
      .json({ erro: "Erro ao verificar login biométrico: " + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — registro de biometria
// ══════════════════════════════════════════════════════════════════

router.get("/api/webauthn/registro/opcoes", requireAuth, async (req, res) => {
  try {
    const opcoes = await webauthn.gerarOpcoesRegistro(req.session.user);
    req.session.webauthnChallenge = opcoes.challenge;
    res.json(opcoes);
  } catch (err) {
    console.error("[webauthn/registro/opcoes]", err.message);
    res.status(500).json({ erro: "Erro ao gerar opções de registro." });
  }
});

router.post(
  "/api/webauthn/registro/verificar",
  requireAuth,
  async (req, res) => {
    try {
      const expectedChallenge = req.session.webauthnChallenge;
      if (!expectedChallenge)
        return res.status(400).json({ erro: "Challenge expirado." });

      const verificacao = await webauthn.verificarRegistro(
        req.body,
        expectedChallenge,
      );
      if (!verificacao.verified)
        return res.status(400).json({ erro: "Verificação falhou." });

      // v9+: registrationInfo.credential.{id, publicKey, counter}
      const {
        id: credentialID,
        publicKey: credentialPublicKey,
        counter,
      } = verificacao.registrationInfo.credential;

      await db.execute(
        "UPDATE user SET webauthn_credential_id=?, webauthn_public_key=?, webauthn_counter=?, webauthn_enabled=1 WHERE id=?",
        [
          credentialID, // base64url string
          Buffer.from(credentialPublicKey).toString("base64"), // standard base64
          counter,
          req.session.user.id,
        ],
      );

      req.session.webauthnChallenge = null;
      req.session.user.webauthn_enabled = 1;
      res.json({ ok: true });
    } catch (err) {
      console.error("[webauthn/registro/verificar]", err.message);
      res
        .status(500)
        .json({ erro: "Erro ao verificar registro: " + err.message });
    }
  },
);

router.post("/api/webauthn/registro/remover", requireAuth, async (req, res) => {
  try {
    await db.execute(
      "UPDATE user SET webauthn_enabled=0, webauthn_credential_id=NULL, webauthn_public_key=NULL, webauthn_counter=0 WHERE id=?",
      [req.session.user.id],
    );
    req.session.user.webauthn_enabled = 0;
    res.json({ ok: true });
  } catch (err) {
    console.error("[webauthn/registro/remover]", err.message);
    res.status(500).json({ erro: "Erro ao remover biometria." });
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBAUTHN — autenticação por biometria
// ══════════════════════════════════════════════════════════════════

router.get("/api/webauthn/auth/opcoes", requireAuth, async (req, res) => {
  try {
    const [[userRow]] = await db.execute(
      "SELECT webauthn_credential_id, webauthn_enabled FROM user WHERE id=?",
      [req.session.user.id],
    );
    if (!userRow?.webauthn_enabled)
      return res.status(400).json({ erro: "Biometria não cadastrada." });
    const opcoes = await webauthn.gerarOpcoesAutenticacao(userRow);
    req.session.webauthnChallenge = opcoes.challenge;
    res.json(opcoes);
  } catch (err) {
    console.error("[webauthn/auth/opcoes]", err.message);
    res.status(500).json({ erro: "Erro ao gerar opções de autenticação." });
  }
});

router.post("/api/webauthn/auth/verificar", requireAuth, async (req, res) => {
  try {
    const expectedChallenge = req.session.webauthnChallenge;
    if (!expectedChallenge)
      return res.status(400).json({ erro: "Challenge expirado." });

    const [[userRow]] = await db.execute(
      "SELECT webauthn_public_key, webauthn_counter FROM user WHERE id=?",
      [req.session.user.id],
    );

    const verificacao = await webauthn.verificarAutenticacao(
      req.body,
      expectedChallenge,
      userRow.webauthn_public_key,
      userRow.webauthn_counter,
    );
    if (!verificacao.verified)
      return res.status(400).json({ erro: "Autenticação falhou." });

    await db.execute("UPDATE user SET webauthn_counter=? WHERE id=?", [
      verificacao.authenticationInfo.newCounter,
      req.session.user.id,
    ]);

    req.session.webauthnChallenge = null;
    res.json({ ok: true, verificado: true });
  } catch (err) {
    console.error("[webauthn/auth/verificar]", err.message);
    res.status(500).json({ erro: "Erro ao verificar autenticação." });
  }
});

// ══════════════════════════════════════════════════════════════════
// CONTA — exclusão com soft delete
// ══════════════════════════════════════════════════════════════════

router.get("/api/conta/info-exclusao", requireAuth, async (req, res) => {
  try {
    const plano = await User.getActivePlan(req.session.user.id);
    res.json({
      temPlanoAtivo: !!plano,
      planoNome: plano?.nome || null,
      planoExpira: plano?.expira_em || null,
    });
  } catch (err) {
    console.error("[conta/info-exclusao]", err.message);
    res.status(500).json({ erro: "Erro ao buscar informações." });
  }
});

router.post("/api/conta/solicitar-exclusao", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const { senha, webauthn_verificado } = req.body;

  try {
    if (!webauthn_verificado) {
      if (!senha)
        return res.status(400).json({ erro: "Confirmação obrigatória." });
      const [[userRow]] = await db.execute(
        "SELECT senha_hash FROM user WHERE id=?",
        [uid],
      );
      const ok = await bcrypt.compare(senha, userRow.senha_hash);
      if (!ok) return res.status(401).json({ erro: "Senha incorreta." });
    }

    const deletion_scheduled_at = new Date();
    deletion_scheduled_at.setDate(deletion_scheduled_at.getDate() + 30);

    await db.execute(
      "UPDATE user SET status='pendente_exclusao', deletion_scheduled_at=? WHERE id=?",
      [deletion_scheduled_at, uid],
    );

    req.session.user.status = "pendente_exclusao";
    req.session.user.deletion_scheduled_at = deletion_scheduled_at;
    res.json({ ok: true, deletion_scheduled_at });
  } catch (err) {
    console.error("[conta/solicitar-exclusao]", err.message);
    res.status(500).json({ erro: "Erro ao agendar exclusão." });
  }
});

router.post("/api/conta/cancelar-exclusao", requireAuth, async (req, res) => {
  try {
    await db.execute(
      "UPDATE user SET status='ativo', deletion_scheduled_at=NULL WHERE id=?",
      [req.session.user.id],
    );
    req.session.user.status = "ativo";
    req.session.user.deletion_scheduled_at = null;
    req.session.user.diasRestantesExclusao = null;
    res.json({ ok: true });
  } catch (err) {
    console.error("[conta/cancelar-exclusao]", err.message);
    res.status(500).json({ erro: "Erro ao cancelar exclusão." });
  }
});

// ====================
// TROCA DE IDIOMA
// ====================
router.get("/lang/:locale", (req, res) => {
  const locale = req.params.locale;
  if (["pt", "en", "es"].includes(locale)) {
    res.cookie("gymbros_lang", locale, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
      sameSite: "Lax",
    });
    i18n.setLocale(req, locale);
  }
  const back = req.headers.referer || "/";
  res.redirect(back);
});

// ── CADASTRO DE ACADEMIA (self-service público) ───────────────────────────────
const {
  sendAguardandoAprovacao,
  sendAlertaAdminNovaAcademia,
} = require("../services/emailGymAdmin");

router.get("/academias/cadastro", (req, res) => {
  res.render("pages/academia-cadastro", { erro: null });
});

router.post(
  "/academias/cadastro",
  [
    body("gym_nome")
      .trim()
      .notEmpty()
      .withMessage("Nome da academia é obrigatório"),
    body("cnpj").trim().notEmpty().withMessage("CNPJ é obrigatório"),
    body("gestor_nome")
      .trim()
      .notEmpty()
      .withMessage("Nome do responsável é obrigatório"),
    body("gestor_email")
      .isEmail()
      .normalizeEmail()
      .withMessage("E-mail inválido"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("pages/academia-cadastro", {
        erro: errors.array()[0].msg,
      });
    }
    const {
      gym_nome,
      cnpj,
      cidade,
      estado,
      endereco,
      gestor_nome,
      gestor_email,
    } = req.body;
    try {
      const [gymRes] = await db.execute(
        `INSERT INTO gym (nome, cnpj, endereco, cidade, estado, status) VALUES (?, ?, ?, ?, ?, 'pendente')`,
        [
          gym_nome.trim(),
          cnpj.trim(),
          endereco || null,
          cidade || null,
          estado || null,
        ],
      );
      const gymId = gymRes.insertId;

      // Gestor inativo (ativo=0) até aprovação
      const { hash } = await (async () => {
        const bcrypt = require("bcryptjs");
        const h = await bcrypt.hash(Math.random().toString(36), 10);
        return { hash: h };
      })();
      const [gaRes] = await db.execute(
        `INSERT INTO gym_admin (gym_id, nome, email, senha_hash, role, ativo) VALUES (?, ?, ?, ?, 'owner', 0)`,
        [gymId, gestor_nome.trim(), gestor_email.trim().toLowerCase(), hash],
      );

      const gym = { nome: gym_nome.trim(), cidade, estado };
      const gestor = { nome: gestor_nome.trim(), email: gestor_email.trim() };

      // Emails em paralelo, sem bloquear o redirect em caso de falha
      Promise.all([
        sendAguardandoAprovacao({ gestor, gym }),
        sendAlertaAdminNovaAcademia({ gym, gestor, adminAcademiaId: gymId }),
      ]).catch((e) =>
        console.error("[cadastro-academia] email error:", e.message),
      );

      res.render("pages/academia-confirmacao", {
        gym_nome: gym_nome.trim(),
        gestor_email: gestor.email,
      });
    } catch (err) {
      console.error("[cadastro-academia]", err);
      const msg =
        err.code === "ER_DUP_ENTRY"
          ? "Este e-mail de gestor já está cadastrado no sistema."
          : "Erro ao registrar academia. Tente novamente.";
      res.render("pages/academia-cadastro", { erro: msg });
    }
  },
);

// ─── F2: Busca de treinos públicos ───────────────────────────────────────────

router.get("/api/treinos/buscar", limiterBusca, requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * limit;

  try {
    const like = `%${q}%`;
    const params = q
      ? [req.session.user.id, like, like, like]
      : [req.session.user.id];

    const [treinos] = await db.execute(
      `
            SELECT
                wp.id,
                wp.nome,
                wp.descricao,
                u.id            AS criador_id,
                u.nome          AS criador_nome,
                u.username      AS criador_username,
                u.profile_photo AS criador_foto,
                JSON_LENGTH(wp.exercicios_json)           AS total_exercicios,
                COUNT(DISTINCT ts.id)                      AS total_execucoes
            FROM workout_plans wp
            JOIN user u ON u.id = wp.user_id
            LEFT JOIN treino_sessao ts ON ts.workout_plan_id = wp.id AND ts.status = 'completo'
            WHERE wp.visibilidade = 'publico'
              AND wp.user_id != ?
              ${q ? "AND (wp.nome LIKE ? OR u.nome LIKE ? OR u.username LIKE ?)" : ""}
            GROUP BY wp.id
            ORDER BY total_execucoes DESC, wp.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `,
      params,
    );

    const countParams = q
      ? [req.session.user.id, like, like, like]
      : [req.session.user.id];
    const [[{ total }]] = await db.execute(
      `
            SELECT COUNT(*) AS total FROM workout_plans wp
            JOIN user u ON u.id = wp.user_id
            WHERE wp.visibilidade = 'publico' AND wp.user_id != ?
            ${q ? "AND (wp.nome LIKE ? OR u.nome LIKE ? OR u.username LIKE ?)" : ""}
        `,
      countParams,
    );

    res.json({ treinos, total, page, totalPaginas: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[/api/treinos/buscar]", err.message);
    res.json({ treinos: [], total: 0 });
  }
});

// ─── F2: Sugestões de pessoas ─────────────────────────────────────────────────

router.get("/api/feed/sugestoes", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    let sugestoes = [];

    // Tentativa 1: amigos de amigos (tabela friendship pode não existir)
    try {
      const [amigosDeAmigos] = await db.execute(
        `
                SELECT DISTINCT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, u.bio
                FROM friendship f1
                JOIN friendship f2 ON f2.user_id = f1.friend_id AND f2.status = 'accepted'
                JOIN user u ON u.id = f2.friend_id
                WHERE f1.user_id = ? AND f1.status = 'accepted'
                  AND f2.friend_id != ?
                  AND u.status = 'ativo'
                  AND u.username IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM friendship fx
                      WHERE (fx.user_id = ? AND fx.friend_id = u.id)
                         OR (fx.user_id = u.id AND fx.friend_id = ?)
                  )
                ORDER BY RAND() LIMIT 5
            `,
        [userId, userId, userId, userId],
      );
      sugestoes = amigosDeAmigos;
    } catch (_) {
      /* friendship ainda não existe */
    }

    // Fallback: usuários aleatórios com username
    if (sugestoes.length < 3) {
      const idsJa = sugestoes.map((s) => s.id).concat([userId]);
      const ph = idsJa.map(() => "?").join(",");
      const needed = 5 - sugestoes.length;
      const [random] = await db.execute(
        `
                SELECT id, nome, username, profile_photo AS foto_perfil, bio
                FROM user
                WHERE id NOT IN (${ph})
                  AND status = 'ativo'
                  AND username IS NOT NULL
                ORDER BY RAND()
                LIMIT ${needed}
            `,
        idsJa,
      );
      sugestoes = [...sugestoes, ...random];
    }

    res.json({ sugestoes });
  } catch (err) {
    console.error("[/api/feed/sugestoes]", err.message);
    res.json({ sugestoes: [] });
  }
});

// ─── F2: Treinos populares ────────────────────────────────────────────────────

router.get("/api/feed/treinos-populares", requireAuth, async (req, res) => {
  try {
    const [treinos] = await db.execute(
      `
            SELECT
                wp.id,
                wp.nome,
                u.nome          AS criador_nome,
                u.username      AS criador_username,
                u.profile_photo AS criador_foto,
                JSON_LENGTH(wp.exercicios_json) AS total_exercicios,
                COUNT(DISTINCT ts.id)            AS total_execucoes
            FROM workout_plans wp
            JOIN user u ON u.id = wp.user_id
            LEFT JOIN treino_sessao ts ON ts.workout_plan_id = wp.id AND ts.status = 'completo'
            WHERE wp.visibilidade = 'publico' AND wp.user_id != ?
            GROUP BY wp.id
            ORDER BY total_execucoes DESC, total_exercicios DESC
            LIMIT 5
        `,
      [req.session.user.id],
    );

    res.json({ treinos });
  } catch (err) {
    console.error("[/api/feed/treinos-populares]", err.message);
    res.json({ treinos: [] });
  }
});

// ─── F1: Perfil público por @username ────────────────────────────────────────

router.get("/u/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const [uRows] = await db.execute(
      `SELECT id, nome, username, bio, profile_photo, status, created_at, instagram_username
             FROM user WHERE username = ? AND status = 'ativo' LIMIT 1`,
      [username],
    );
    if (!uRows.length)
      return res
        .status(404)
        .render("pages/404", { user: req.session.user || null });
    const u = uRows[0];

    const visitante = req.session.user || null;
    const isDono = !!(visitante && String(visitante.id) === String(u.id));

    const lista = await conquistas.getConquistasUsuario(u.id);
    const desbloqueadas = lista.filter((c) => c.desbloqueada);

    const [[{ totalSessoes }]] = await db.execute(
      'SELECT COUNT(*) as totalSessoes FROM treino_sessao WHERE user_id = ? AND status = "completo"',
      [u.id],
    );

    const [conquistasHero] = await db.execute(
      `SELECT c.slug, c.nome, c.tier, c.icone
             FROM usuario_conquistas uc
             JOIN conquistas c ON c.id = uc.conquista_id
             WHERE uc.user_id = ?
             ORDER BY uc.desbloqueada_em DESC LIMIT 3`,
      [u.id],
    );

    const [checkinRows] = await db.execute(
      `SELECT DATE(created_at) as dia FROM treino_checkins
             WHERE user_id = ? GROUP BY DATE(created_at) ORDER BY dia DESC LIMIT 60`,
      [u.id],
    );
    let streak = 0;
    let diaAnterior = null;
    for (const row of checkinRows) {
      const dia = new Date(row.dia);
      if (!diaAnterior) {
        streak = 1;
      } else {
        const diff = (diaAnterior - dia) / (1000 * 60 * 60 * 24);
        if (diff === 1) streak++;
        else break;
      }
      diaAnterior = dia;
    }

    let statusAmizade = "none";
    let fsId = null;
    if (visitante && !isDono) {
      try {
        const vid = visitante.id;
        const [fRows] = await db.execute(
          `SELECT id, status, solicitante_id FROM friendship
                     WHERE (solicitante_id = ? AND destinatario_id = ?)
                        OR (solicitante_id = ? AND destinatario_id = ?)
                     LIMIT 1`,
          [vid, u.id, u.id, vid],
        );
        if (fRows.length) {
          const f = fRows[0];
          fsId = f.id;
          if (f.status === "aceito") statusAmizade = "friends";
          else if (f.status === "bloqueado") statusAmizade = "blocked";
          else if (String(f.solicitante_id) === String(vid))
            statusAmizade = "pending_sent";
          else statusAmizade = "pending_received";
        }
      } catch (_) {}
    }

    res.render("pages/perfil-publico", {
      user: visitante,
      visitante,
      isDono,
      perfil: u,
      conquistas: desbloqueadas,
      conquistasHero,
      totalSessoes,
      streak,
      statusAmizade,
      fsId,
      perfilId: u.id,
      isProprioPerfilId: isDono,
      seo: {
        title: `${u.nome} (@${u.username}) — FitCrew`,
        description: u.bio || `Perfil de ${u.nome} no FitCrew`,
        canonical: `/u/${u.username}`,
        robots: "index, follow",
      },
    });
  } catch (err) {
    console.error("[/u/:username]", err.message);
    res.status(500).redirect("/");
  }
});

// ─── F1: QR Code — redireciona para /perfil/:username ────────────────────────

router.get("/qr/:token", async (req, res) => {
  try {
    const [[user]] = await db.execute(
      "SELECT username FROM user WHERE qr_token = ? LIMIT 1",
      [req.params.token],
    );
    if (!user || !user.username) return res.redirect("/");
    res.redirect(`/perfil/${user.username}`);
  } catch (err) {
    res.redirect("/");
  }
});

// ─── F1: APIs de perfil ───────────────────────────────────────────────────────

router.post("/api/perfil/username", requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username || !/^[a-z0-9_]{3,30}$/.test(username)) {
    return res.json({
      ok: false,
      erro: "Username inválido. Use 3-30 caracteres: letras minúsculas, números e _",
    });
  }
  try {
    const [[existe]] = await db.execute(
      "SELECT id FROM user WHERE username = ? AND id != ?",
      [username, req.session.user.id],
    );
    if (existe)
      return res.json({ ok: false, erro: "Username já está em uso." });

    const { moderarTexto } = require("../services/moderacao");
    const mod = await moderarTexto(username, "username");
    if (mod.decisao === "rejeitado") {
      return res.json({ ok: false, erro: "Username não permitido." });
    }

    await db.execute("UPDATE user SET username = ? WHERE id = ?", [
      username,
      req.session.user.id,
    ]);
    req.session.user.username = username;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, erro: "Erro ao atualizar username." });
  }
});

router.post("/api/perfil/bio", requireAuth, async (req, res) => {
  const bio = (req.body.bio || "").slice(0, 160).trim();
  try {
    await db.execute("UPDATE user SET bio = ? WHERE id = ?", [
      bio,
      req.session.user.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, erro: "Erro ao atualizar bio." });
  }
});

router.post("/api/perfil/visibilidade", requireAuth, async (req, res) => {
  const publico = req.body.publico === "1" || req.body.publico === true ? 1 : 0;
  try {
    await db.execute("UPDATE user SET perfil_publico = ? WHERE id = ?", [
      publico,
      req.session.user.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, erro: "Erro ao atualizar visibilidade." });
  }
});

router.get("/api/perfil/check-username", requireAuth, async (req, res) => {
  const u = (req.query.u || "").toLowerCase().trim();
  if (!u) return res.json({ disponivel: false, motivo: "invalid" });
  if (!/^[a-z0-9_]{3,30}$/.test(u))
    return res.json({ disponivel: false, motivo: "invalid" });
  try {
    const [[existe]] = await db.execute(
      "SELECT id FROM user WHERE username = ? AND id != ?",
      [u, req.session.user.id],
    );
    res.json({ disponivel: !existe, motivo: existe ? "taken" : null });
  } catch (err) {
    res.json({ disponivel: false, motivo: "error" });
  }
});

// ─── F1: Busca de usuários ────────────────────────────────────────────────────

router.get("/api/usuarios/buscar", limiterBusca, requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 20);
  const offset = (page - 1) * limit;
  const userId = req.session.user.id;

  if (!q) return res.json({ usuarios: [], total: 0 });

  const naoBloqueado = `
        AND NOT EXISTS (
            SELECT 1 FROM friendship f
            WHERE f.status = 'bloqueado'
              AND ((f.solicitante_id = ? AND f.destinatario_id = user.id)
                OR (f.solicitante_id = user.id AND f.destinatario_id = ?))
        )
    `;

  try {
    const like = `%${q}%`;
    const [usuarios] = await db.execute(
      `
            SELECT id, nome, username, profile_photo AS foto_perfil, bio, nivel, streak_atual
            FROM user
            WHERE (nome LIKE ? OR username LIKE ?)
              AND status = 'ativo'
              AND username IS NOT NULL
              AND id != ?
              ${naoBloqueado}
            ORDER BY
                CASE WHEN username = ? THEN 0
                     WHEN username LIKE ? THEN 1
                     ELSE 2 END,
                nome ASC
            LIMIT ${limit} OFFSET ${offset}
        `,
      [like, like, userId, userId, userId, q, `${q}%`],
    );

    const [[{ total }]] = await db.execute(
      `
            SELECT COUNT(*) AS total FROM user
            WHERE (nome LIKE ? OR username LIKE ?)
              AND status = 'ativo'
              AND username IS NOT NULL
              AND id != ?
              ${naoBloqueado}
        `,
      [like, like, userId, userId, userId],
    );

    res.json({ usuarios, total, page, totalPaginas: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[/api/usuarios/buscar]", err.message);
    res.json({ usuarios: [], total: 0 });
  }
});

// ─── Buscar: sugestões de pessoas ────────────────────────────────────────────

router.get("/api/buscar/sugestoes-pessoas", limiterBusca, requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    let sugestoes = [];

    // Amigos de amigos (friendship pode não existir)
    try {
      const [r] = await db.execute(
        `
                SELECT DISTINCT u.id, u.nome, u.username,
                       u.profile_photo AS foto_perfil, u.bio, u.nivel, u.streak_atual
                FROM friendship f1
                JOIN friendship f2 ON f2.user_id = f1.friend_id AND f2.status = 'accepted'
                JOIN user u ON u.id = f2.friend_id
                WHERE f1.user_id = ? AND f1.status = 'accepted'
                  AND f2.friend_id != ?
                  AND u.status = 'ativo'
                  AND u.username IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM friendship fx
                    WHERE (fx.user_id = ? AND fx.friend_id = u.id)
                       OR (fx.user_id = u.id AND fx.friend_id = ?)
                  )
                ORDER BY RAND() LIMIT 5
            `,
        [userId, userId, userId, userId],
      );
      sugestoes = r;
    } catch (_) {}

    // Fallback: qualquer usuário ativo
    if (sugestoes.length < 3) {
      const idsJa = sugestoes.map((s) => s.id).concat([userId]);
      const ph = idsJa.map(() => "?").join(",");
      const needed = 6 - sugestoes.length;
      const [r] = await db.execute(
        `
                SELECT id, nome, username, profile_photo AS foto_perfil, bio, nivel, streak_atual
                FROM user
                WHERE id NOT IN (${ph})
                  AND status = 'ativo' AND username IS NOT NULL
                ORDER BY RAND() LIMIT ${needed}
            `,
        idsJa,
      );
      sugestoes = [...sugestoes, ...r];
    }

    res.json({ sugestoes });
  } catch (err) {
    console.error("[/api/buscar/sugestoes-pessoas]", err.message);
    res.json({ sugestoes: [] });
  }
});

// ─── Buscar: "assuntos para você" — treinos por grupos musculares ─────────────

router.get("/api/buscar/assuntos", limiterBusca, requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    // Grupos musculares mais treinados pelo usuário
    const [grupos] = await db.execute(
      `
            SELECT e.body_part AS grupo, COUNT(*) AS total
            FROM treino_sessao ts
            JOIN treino_sessao_exercicio tse ON tse.sessao_id = ts.id
            JOIN exercises e ON LOWER(e.name) = LOWER(tse.exercise_query)
            WHERE ts.user_id = ? AND ts.status = 'completo'
              AND e.body_part IS NOT NULL AND e.body_part != ''
            GROUP BY e.body_part
            ORDER BY total DESC
            LIMIT 3
        `,
      [userId],
    );

    if (!grupos.length) {
      return res.json({ treinos: [], grupos: [], semHistorico: true });
    }

    const gruposNomes = grupos.map((g) => g.grupo);
    const ph = gruposNomes.map(() => "?").join(",");

    // Treinos públicos que usam esses grupos musculares (via sessões já registradas)
    const [treinos] = await db.execute(
      `
            SELECT wp.id, wp.nome,
                u.nome          AS criador_nome,
                u.username      AS criador_username,
                u.profile_photo AS criador_foto,
                JSON_LENGTH(wp.exercicios_json) AS total_exercicios,
                (SELECT COUNT(*) FROM treino_sessao ts3
                 WHERE ts3.workout_plan_id = wp.id AND ts3.status = 'completo') AS total_execucoes
            FROM workout_plans wp
            JOIN user u ON u.id = wp.user_id
            WHERE wp.visibilidade = 'publico'
              AND wp.user_id != ?
              AND EXISTS (
                SELECT 1 FROM treino_sessao ts2
                JOIN treino_sessao_exercicio tse2 ON tse2.sessao_id = ts2.id
                JOIN exercises e2 ON LOWER(e2.name) = LOWER(tse2.exercise_query)
                WHERE ts2.workout_plan_id = wp.id
                  AND ts2.status = 'completo'
                  AND e2.body_part IN (${ph})
              )
            ORDER BY total_execucoes DESC
            LIMIT 8
        `,
      [userId, ...gruposNomes],
    );

    res.json({ treinos, grupos: gruposNomes, semHistorico: false });
  } catch (err) {
    console.error("[/api/buscar/assuntos]", err.message);
    res.json({ treinos: [], grupos: [], semHistorico: true });
  }
});

// ─── F12: Treinos sociais ────────────────────────────────────────────────────

// Lista de amigos convidáveis para um treino (só o dono)
router.get("/api/treinos/:id/convidaveis", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  if (!planId) return res.status(400).json({ ok: false });
  try {
    const [[plano]] = await db.execute(
      "SELECT id, modo_colaboracao FROM workout_plans WHERE id = ? AND user_id = ?",
      [planId, userId],
    );
    if (!plano)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });

    const [amigos] = await db.execute(
      `SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil,
              wm.status AS convite_status
         FROM friendship f
         JOIN user u
           ON u.id = IF(f.solicitante_id = ?, f.destinatario_id, f.solicitante_id)
         LEFT JOIN workout_membros wm
           ON wm.plan_id = ? AND wm.user_id = u.id
        WHERE (f.solicitante_id = ? OR f.destinatario_id = ?)
          AND f.status = 'aceito'
          AND u.status = 'ativo'
        ORDER BY u.nome ASC`,
      [userId, planId, userId, userId],
    );
    res.json({ ok: true, amigos, modo: plano.modo_colaboracao });
  } catch (err) {
    console.error("[/api/treinos/convidaveis]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Convidar amigo para o treino (só o dono)
router.post("/api/treinos/:id/convidar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  const amigoId = parseInt(req.body.amigoId, 10);
  const modo = req.body.modo;
  if (!planId || !amigoId)
    return res.status(400).json({ ok: false, erro: "Dados inválidos." });
  if (amigoId === userId)
    return res.status(400).json({ ok: false, erro: "Convite inválido." });
  try {
    // Verifica que o plano pertence ao usuário logado
    const [[plano]] = await db.execute(
      "SELECT id, nome FROM workout_plans WHERE id = ? AND user_id = ?",
      [planId, userId],
    );
    if (!plano)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });

    // Verifica que amigoId é amigo aceito do usuário logado
    const [[amizade]] = await db.execute(
      `SELECT id FROM friendship
        WHERE status = 'aceito'
          AND ((solicitante_id = ? AND destinatario_id = ?)
            OR (solicitante_id = ? AND destinatario_id = ?))`,
      [userId, amigoId, amigoId, userId],
    );
    if (!amizade)
      return res.status(403).json({ ok: false, erro: "Vocês não são amigos." });

    if (modo === "readonly" || modo === "editavel") {
      await db.execute(
        "UPDATE workout_plans SET modo_colaboracao = ? WHERE id = ? AND user_id = ?",
        [modo, planId, userId],
      );
    }

    await db.execute(
      `INSERT INTO workout_membros (plan_id, user_id, status)
       VALUES (?, ?, 'pendente')
       ON DUPLICATE KEY UPDATE status = 'pendente'`,
      [planId, amigoId],
    );

    await criarNotificacao(
      amigoId,
      "convite_treino",
      `${req.session.user.nome} te convidou para o treino ${plano.nome}`,
      "Toque para ver o treino e decidir se quer participar",
      {
        plan_id: planId,
        plan_nome: plano.nome,
        convidante_nome: req.session.user.nome,
      },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/treinos/convidar]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Responder a um convite de treino (membro convidado)
router.post(
  "/api/treinos/:id/responder-convite",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const planId = parseInt(req.params.id, 10);
    const aceitar = req.body.aceitar === true || req.body.aceitar === "true";
    if (!planId) return res.status(400).json({ ok: false });
    try {
      const [[membro]] = await db.execute(
        "SELECT id FROM workout_membros WHERE plan_id = ? AND user_id = ? AND status = 'pendente'",
        [planId, userId],
      );
      if (!membro)
        return res
          .status(404)
          .json({ ok: false, erro: "Convite não encontrado." });

      await db.execute("UPDATE workout_membros SET status = ? WHERE id = ?", [
        aceitar ? "aceito" : "recusado",
        membro.id,
      ]);

      const [[plano]] = await db.execute(
        "SELECT nome, user_id FROM workout_plans WHERE id = ?",
        [planId],
      );
      if (plano) {
        await criarNotificacao(
          plano.user_id,
          aceitar ? "convite_aceito" : "convite_recusado",
          aceitar
            ? `${req.session.user.nome} aceitou seu convite para ${plano.nome}`
            : `${req.session.user.nome} recusou seu convite para ${plano.nome}`,
          null,
          { plan_id: planId, plan_nome: plano.nome },
        );
      }
      res.json({ ok: true, aceito: aceitar });
    } catch (err) {
      console.error("[/api/treinos/responder-convite]", err.message);
      res.status(500).json({ ok: false });
    }
  },
);

// Membros de um treino (dono ou membro aceito)
router.get("/api/treinos/:id/membros", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  if (!planId) return res.status(400).json({ ok: false });
  try {
    const acesso = await carregarPlanoComAcesso(planId, userId);
    if (!acesso)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });
    const [membros] = await db.execute(
      `SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, wm.status
         FROM workout_membros wm
         JOIN user u ON u.id = wm.user_id
        WHERE wm.plan_id = ?
        ORDER BY wm.created_at ASC`,
      [planId],
    );
    res.json({
      ok: true,
      membros,
      isOwner: acesso.isOwner,
      modo_colaboracao: acesso.plano.modo_colaboracao,
    });
  } catch (err) {
    console.error("[/api/treinos/membros]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Remover um membro do treino (só o dono)
router.delete(
  "/api/treinos/:id/membros/:userId",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const planId = parseInt(req.params.id, 10);
    const alvoId = parseInt(req.params.userId, 10);
    if (!planId || !alvoId) return res.status(400).json({ ok: false });
    try {
      const [[plano]] = await db.execute(
        "SELECT id, nome FROM workout_plans WHERE id = ? AND user_id = ?",
        [planId, userId],
      );
      if (!plano)
        return res.status(403).json({ ok: false, erro: "Sem permissão." });
      const [result] = await db.execute(
        "DELETE FROM workout_membros WHERE plan_id = ? AND user_id = ?",
        [planId, alvoId],
      );
      if (result.affectedRows) {
        await criarNotificacao(
          alvoId,
          "removido_treino",
          `Você foi removido do treino ${plano.nome}`,
          null,
          { plan_id: planId, plan_nome: plano.nome },
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/treinos/membros/delete]", err.message);
      res.status(500).json({ ok: false });
    }
  },
);

// Sair de um treino (membro)
router.post("/api/treinos/:id/sair", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  if (!planId) return res.status(400).json({ ok: false });
  try {
    await db.execute(
      "DELETE FROM workout_membros WHERE plan_id = ? AND user_id = ?",
      [planId, userId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/treinos/sair]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Alterar o modo de colaboração (só o dono)
router.patch("/api/treinos/:id/colaboracao", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  const modo = req.body.modo;
  if (!planId || !["readonly", "editavel"].includes(modo))
    return res.status(400).json({ ok: false, erro: "Dados inválidos." });
  try {
    const [result] = await db.execute(
      "UPDATE workout_plans SET modo_colaboracao = ? WHERE id = ? AND user_id = ?",
      [modo, planId, userId],
    );
    if (!result.affectedRows)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });
    res.json({ ok: true, modo });
  } catch (err) {
    console.error("[/api/treinos/colaboracao]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Editar um treino — dono sempre; membro só se modo_colaboracao = 'editavel'
router.put("/api/treinos/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const planId = parseInt(req.params.id, 10);
  const { nome, descricao, exercicios_json } = req.body;
  if (!planId) return res.status(400).json({ ok: false });
  try {
    const acesso = await carregarPlanoComAcesso(planId, userId);
    if (!acesso)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });
    const podeEditar =
      acesso.isOwner ||
      (acesso.isMembro && acesso.plano.modo_colaboracao === "editavel");
    if (!podeEditar)
      return res
        .status(403)
        .json({ ok: false, erro: "Este treino é somente leitura." });

    const campos = [];
    const valores = [];
    if (typeof nome === "string" && nome.trim()) {
      campos.push("nome = ?");
      valores.push(nome.trim().slice(0, 255));
    }
    if (typeof descricao === "string") {
      campos.push("descricao = ?");
      valores.push(descricao.slice(0, 2000));
    }
    if (Array.isArray(exercicios_json)) {
      campos.push("exercicios_json = ?");
      valores.push(JSON.stringify(exercicios_json));
    }
    if (!campos.length)
      return res.status(400).json({ ok: false, erro: "Nada para atualizar." });
    valores.push(planId);
    await db.execute(
      `UPDATE workout_plans SET ${campos.join(", ")} WHERE id = ?`,
      valores,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/treinos/editar]", err.message);
    res.status(500).json({ ok: false });
  }
});

// ─── F13: Agenda com amigos ──────────────────────────────────────────────────

// Verifica se dois usuários são amigos aceitos
async function saoAmigos(userIdA, userIdB) {
  const [[row]] = await db.execute(
    `SELECT id FROM friendship
      WHERE status = 'aceito'
        AND ((solicitante_id = ? AND destinatario_id = ?)
          OR (solicitante_id = ? AND destinatario_id = ?))`,
    [userIdA, userIdB, userIdB, userIdA],
  );
  return !!row;
}

// Criar evento de treino (individual ou grupo)
router.post("/api/agenda/evento", requireAuth, async (req, res) => {
  const criadorId = req.session.user.id;
  const { nome, descricao, data_hora, workout_plan_id, convidados } =
    req.body;

  const nomeLimpo = typeof nome === "string" ? nome.trim() : "";
  if (!nomeLimpo)
    return res.status(400).json({ ok: false, erro: "Nome obrigatório." });

  const dataHoraDate = new Date(data_hora);
  if (isNaN(dataHoraDate.getTime()) || dataHoraDate <= new Date())
    return res
      .status(400)
      .json({ ok: false, erro: "Data e hora devem ser no futuro." });

  let planoId = null;
  if (workout_plan_id) {
    const acesso = await carregarPlanoComAcesso(
      parseInt(workout_plan_id, 10),
      criadorId,
    );
    if (!acesso)
      return res
        .status(403)
        .json({ ok: false, erro: "Treino inválido para este usuário." });
    planoId = acesso.plano.id;
  }

  try {
    // Filtra apenas amigos aceitos — nunca permite convidar não-amigos
    const candidatos = Array.isArray(convidados)
      ? [...new Set(convidados.map((c) => parseInt(c, 10)))].filter(
          (id) => id && id !== criadorId,
        )
      : [];
    const validos = [];
    for (const uid of candidatos) {
      if (await saoAmigos(criadorId, uid)) validos.push(uid);
    }
    if (!validos.length)
      return res
        .status(400)
        .json({ ok: false, erro: "Convide pelo menos um amigo." });

    const tipo = validos.length > 1 ? "grupo" : "individual";

    const [result] = await db.execute(
      `INSERT INTO treino_evento (criador_id, nome, descricao, data_hora, workout_plan_id, tipo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        criadorId,
        nomeLimpo.slice(0, 200),
        typeof descricao === "string" ? descricao.trim().slice(0, 500) || null : null,
        data_hora,
        planoId,
        tipo,
      ],
    );
    const eventoId = result.insertId;

    for (const uid of validos) {
      await db.execute(
        `INSERT IGNORE INTO treino_evento_participante (evento_id, user_id, status)
         VALUES (?, ?, 'pendente')`,
        [eventoId, uid],
      );
      await criarNotificacao(
        uid,
        "convite_evento",
        `${req.session.user.nome} te convidou para treinar`,
        `${nomeLimpo} — ${dataHoraDate.toLocaleDateString("pt-BR")}`,
        { evento_id: eventoId, evento_nome: nomeLimpo },
      );
    }

    res.json({ ok: true, eventoId });
  } catch (err) {
    console.error("[/api/agenda/evento POST]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Confirmar/recusar presença em um evento
router.post(
  "/api/agenda/evento/:id/responder",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const eventoId = parseInt(req.params.id, 10);
    const status = req.body.status;
    if (!eventoId || !["confirmado", "talvez", "recusado"].includes(status))
      return res.status(400).json({ ok: false, erro: "Dados inválidos." });
    try {
      const [result] = await db.execute(
        "UPDATE treino_evento_participante SET status = ? WHERE evento_id = ? AND user_id = ?",
        [status, eventoId, userId],
      );
      if (!result.affectedRows)
        return res
          .status(404)
          .json({ ok: false, erro: "Convite não encontrado." });

      const [[evento]] = await db.execute(
        "SELECT nome, criador_id FROM treino_evento WHERE id = ?",
        [eventoId],
      );
      if (evento && evento.criador_id !== userId) {
        const rotulo =
          status === "confirmado"
            ? "confirmou presença"
            : status === "talvez"
              ? "talvez compareça"
              : "não vai comparecer";
        await criarNotificacao(
          evento.criador_id,
          "evento_resposta",
          `${req.session.user.nome} ${rotulo}`,
          evento.nome,
          { evento_id: eventoId, evento_nome: evento.nome },
        );
      }
      res.json({ ok: true, status });
    } catch (err) {
      console.error("[/api/agenda/evento/responder]", err.message);
      res.status(500).json({ ok: false });
    }
  },
);

// Agenda do usuário — eventos criados + eventos onde é convidado
router.get("/api/agenda", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const baseSelect = `
      SELECT te.*,
             (SELECT COUNT(*) FROM treino_evento_participante x WHERE x.evento_id = te.id AND x.status = 'confirmado') AS total_confirmados,
             (SELECT COUNT(*) FROM treino_evento_participante x WHERE x.evento_id = te.id AND x.status = 'pendente')   AS total_pendentes,
             tep.status AS meu_status
        FROM treino_evento te
        LEFT JOIN treino_evento_participante tep ON tep.evento_id = te.id AND tep.user_id = ?
       WHERE te.status = 'ativo'
         AND (te.criador_id = ? OR (tep.user_id = ? AND tep.status != 'recusado'))
    `;
    const [proximos] = await db.execute(
      `${baseSelect} AND te.data_hora >= NOW() ORDER BY te.data_hora ASC`,
      [userId, userId, userId],
    );
    const [historico] = await db.execute(
      `${baseSelect} AND te.data_hora < NOW() ORDER BY te.data_hora DESC`,
      [userId, userId, userId],
    );
    res.json({ proximos, historico });
  } catch (err) {
    console.error("[/api/agenda]", err.message);
    res.json({ proximos: [], historico: [] });
  }
});

// Detalhes de um evento (criador ou participante)
router.get("/api/agenda/evento/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const eventoId = parseInt(req.params.id, 10);
  if (!eventoId) return res.status(400).json({ ok: false });
  try {
    const [[evento]] = await db.execute(
      "SELECT * FROM treino_evento WHERE id = ?",
      [eventoId],
    );
    if (!evento) return res.status(404).json({ ok: false });

    const [[souParticipante]] = await db.execute(
      "SELECT id FROM treino_evento_participante WHERE evento_id = ? AND user_id = ?",
      [eventoId, userId],
    );
    if (evento.criador_id !== userId && !souParticipante)
      return res.status(403).json({ ok: false, erro: "Sem permissão." });

    const [participantes] = await db.execute(
      `SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, tep.status
         FROM treino_evento_participante tep
         JOIN user u ON u.id = tep.user_id
        WHERE tep.evento_id = ?
        ORDER BY tep.created_at ASC`,
      [eventoId],
    );
    res.json({ ok: true, evento, participantes });
  } catch (err) {
    console.error("[/api/agenda/evento GET]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Cancelar evento (só o criador)
router.delete("/api/agenda/evento/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const eventoId = parseInt(req.params.id, 10);
  if (!eventoId) return res.status(400).json({ ok: false });
  try {
    const [result] = await db.execute(
      "UPDATE treino_evento SET status = 'cancelado' WHERE id = ? AND criador_id = ? AND status = 'ativo'",
      [eventoId, userId],
    );
    if (!result.affectedRows)
      return res
        .status(403)
        .json({ ok: false, erro: "Sem permissão ou evento já cancelado." });

    const [[evento]] = await db.execute(
      "SELECT nome FROM treino_evento WHERE id = ?",
      [eventoId],
    );
    const [confirmados] = await db.execute(
      "SELECT user_id FROM treino_evento_participante WHERE evento_id = ? AND status = 'confirmado'",
      [eventoId],
    );
    for (const p of confirmados) {
      await criarNotificacao(
        p.user_id,
        "evento_cancelado",
        `Evento cancelado: ${evento?.nome ?? ""}`,
        `${req.session.user.nome} cancelou o evento`,
        { evento_id: eventoId, evento_nome: evento?.nome ?? "" },
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/agenda/evento DELETE]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Sair de um evento (participante convidado)
router.delete(
  "/api/agenda/evento/:id/sair",
  requireAuth,
  async (req, res) => {
    const userId = req.session.user.id;
    const eventoId = parseInt(req.params.id, 10);
    if (!eventoId) return res.status(400).json({ ok: false });
    try {
      await db.execute(
        "UPDATE treino_evento_participante SET status = 'recusado' WHERE evento_id = ? AND user_id = ?",
        [eventoId, userId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/agenda/evento/sair]", err.message);
      res.status(500).json({ ok: false });
    }
  },
);

// ─── F17: GymSquads (grupos de desafio) ────────────────────────────────────────

const TIPOS_DESAFIO_GYMSQUAD = [
  "frequencia",
  "carga",
  "distancia",
  "tempo",
  "personalizado",
];

// Lista de gymsquads do usuário (página)
router.get("/gymsquads", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const ctx = {
    user: req.session.user,
    gymsquads: [],
    placares: {},
    convites: [],
    page: "gymsquads",
    seo: {
      title: "GymSquads — FitCrew",
      canonical: "/gymsquads",
      robots: "noindex, nofollow",
    },
  };
  try {
    const [gymsquads] = await db.execute(
      `SELECT g.*, gm.role, gm.pontuacao AS minha_pontuacao,
              u.nome AS criador_nome,
              (SELECT COUNT(*) FROM gymsquad_membro WHERE gymsquad_id = g.id) AS total_membros
       FROM gymsquad_membro gm
       JOIN gymsquad g ON g.id = gm.gymsquad_id
       JOIN user u ON u.id = g.criador_id
       WHERE gm.user_id = ?
       ORDER BY g.status ASC, g.data_fim ASC`,
      [userId],
    );
    const placares = {};
    for (const g of gymsquads) {
      placares[g.id] = await buscarPlacar(g.id);
    }
    const [convites] = await db.execute(
      `SELECT gc.gymsquad_id, g.nome, g.tipo_desafio, g.data_inicio, g.data_fim,
              u.nome AS criador_nome
       FROM gymsquad_convite gc
       JOIN gymsquad g ON g.id = gc.gymsquad_id
       JOIN user u ON u.id = g.criador_id
       WHERE gc.user_id = ? AND gc.status = 'pendente' AND g.status = 'ativo'
       ORDER BY gc.created_at DESC`,
      [userId],
    );
    res.render("pages/gymsquads", { ...ctx, gymsquads, placares, convites });
  } catch (err) {
    console.error("[/gymsquads]", err.message);
    res.render("pages/gymsquads", ctx);
  }
});

// Detalhe de um gymsquad (placar + feed) — só pra membros
router.get("/gymsquads/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  if (!gymsquadId) return res.redirect("/gymsquads");
  try {
    const [[membro]] = await db.execute(
      "SELECT role FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro) return res.redirect("/gymsquads");

    const [[gymsquad]] = await db.execute("SELECT * FROM gymsquad WHERE id = ?", [
      gymsquadId,
    ]);
    if (!gymsquad) return res.redirect("/gymsquads");

    const placar = await buscarPlacar(gymsquadId);
    res.render("pages/gymsquads-detalhe", {
      user: req.session.user,
      gymsquad,
      placar,
      souAdmin: membro.role === "admin",
      page: "gymsquads",
      seo: {
        title: `${gymsquad.nome} — FitCrew`,
        canonical: `/gymsquads/${gymsquadId}`,
        robots: "noindex, nofollow",
      },
    });
  } catch (err) {
    console.error("[/gymsquads/:id]", err.message);
    res.redirect("/gymsquads");
  }
});

// Amigos elegíveis pra convite (usado pelo modal de criação)
router.get("/api/gymsquads/amigos-convidaveis", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const amigosIds = (await buscarAmigosIds(userId)).filter(
      (id) => id !== userId,
    );
    if (!amigosIds.length) return res.json({ amigos: [] });
    const placeholders = amigosIds.map(() => "?").join(",");
    const [amigos] = await db.execute(
      `SELECT id, nome, username, profile_photo AS foto_perfil FROM user WHERE id IN (${placeholders})`,
      amigosIds,
    );
    res.json({ amigos });
  } catch (err) {
    console.error("[/api/gymsquads/amigos-convidaveis]", err.message);
    res.json({ amigos: [] });
  }
});

// Criar gymsquad
router.post("/api/gymsquads", requireAuth, async (req, res) => {
  const criadorId = req.session.user.id;
  const {
    nome,
    descricao,
    tipo_desafio,
    descricao_meta,
    data_inicio,
    data_fim,
    convidados,
  } = req.body;

  if (!nome?.trim() || !tipo_desafio || !data_inicio || !data_fim) {
    return res
      .status(400)
      .json({ ok: false, erro: "Preencha todos os campos obrigatórios." });
  }
  if (!TIPOS_DESAFIO_GYMSQUAD.includes(tipo_desafio)) {
    return res.status(400).json({ ok: false, erro: "Tipo de desafio inválido." });
  }
  if (tipo_desafio === "personalizado" && !descricao_meta?.trim()) {
    return res
      .status(400)
      .json({ ok: false, erro: "Descreva a meta do desafio personalizado." });
  }
  const inicio = new Date(`${data_inicio}T00:00:00`);
  const fim = new Date(`${data_fim}T00:00:00`);
  if (isNaN(inicio.getTime()) || isNaN(fim.getTime()) || fim < inicio) {
    return res.status(400).json({ ok: false, erro: "Período inválido." });
  }

  try {
    const nomeLimpo = nome.trim().slice(0, 200);
    const [result] = await db.execute(
      `INSERT INTO gymsquad (nome, descricao, criador_id, tipo_desafio, descricao_meta, data_inicio, data_fim)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nomeLimpo,
        descricao?.trim().slice(0, 500) || null,
        criadorId,
        tipo_desafio,
        descricao_meta?.trim().slice(0, 300) || null,
        data_inicio,
        data_fim,
      ],
    );
    const gymsquadId = result.insertId;

    await db.execute(
      'INSERT INTO gymsquad_membro (gymsquad_id, user_id, role) VALUES (?, ?, "admin")',
      [gymsquadId, criadorId],
    );

    const candidatos = Array.isArray(convidados)
      ? [...new Set(convidados.map((c) => parseInt(c, 10)))].filter(
          (id) => id && id !== criadorId,
        )
      : [];
    for (const uid of candidatos) {
      if (!(await saoAmigos(criadorId, uid))) continue;
      await db.execute(
        "INSERT IGNORE INTO gymsquad_convite (gymsquad_id, user_id) VALUES (?, ?)",
        [gymsquadId, uid],
      );
      await criarNotificacao(
        uid,
        "convite_gymsquad",
        `${req.session.user.nome} te convidou para o GymSquad "${nomeLimpo}"`,
        `Desafio de ${tipo_desafio} — ${data_inicio} a ${data_fim}`,
        { gymsquad_id: gymsquadId, gymsquad_nome: nomeLimpo },
      );
    }

    res.json({ ok: true, gymsquadId });
  } catch (err) {
    console.error("[POST /api/gymsquads]", err.message);
    res.status(500).json({ ok: false, erro: "Erro ao criar gymsquad." });
  }
});

// Aceitar/recusar convite de gymsquad
router.post("/api/gymsquads/:id/responder", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  const aceitar = req.body.aceitar === true || req.body.aceitar === "true";
  if (!gymsquadId) return res.status(400).json({ ok: false });

  try {
    const [[convite]] = await db.execute(
      'SELECT id FROM gymsquad_convite WHERE gymsquad_id = ? AND user_id = ? AND status = "pendente"',
      [gymsquadId, userId],
    );
    if (!convite)
      return res.json({ ok: false, erro: "Convite não encontrado." });

    await db.execute(
      "UPDATE gymsquad_convite SET status = ? WHERE gymsquad_id = ? AND user_id = ?",
      [aceitar ? "aceito" : "recusado", gymsquadId, userId],
    );

    if (aceitar) {
      await db.execute(
        "INSERT IGNORE INTO gymsquad_membro (gymsquad_id, user_id) VALUES (?, ?)",
        [gymsquadId, userId],
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/gymsquads/:id/responder]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Feed do gymsquad (paginado por cursor)
router.get("/api/gymsquads/:id/feed", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  const lastId = req.query.last_id ? parseInt(req.query.last_id, 10) : null;
  const limit = 10;
  if (!gymsquadId) return res.json({ posts: [], hasMore: false });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro) return res.json({ posts: [], hasMore: false });

    const params = [gymsquadId];
    let cursorClause = "";
    if (lastId) {
      cursorClause = "AND p.id < ?";
      params.push(lastId);
    }
    const [posts] = await db.execute(
      `SELECT p.id, p.legenda, p.tipo, p.total_reacoes, p.total_comentarios, p.created_at,
              u.id AS autor_id, u.nome AS autor_nome,
              u.username AS autor_username, u.profile_photo AS autor_foto
       FROM gymsquad_post gp
       JOIN post p ON p.id = gp.post_id
       JOIN user u ON u.id = p.user_id
       WHERE gp.gymsquad_id = ? AND p.status = 'ativo' ${cursorClause}
       ORDER BY p.id DESC
       LIMIT ${limit}`,
      params,
    );

    for (const post of posts) {
      const [midias] = await db.execute(
        "SELECT url, tipo, ordem FROM post_midia WHERE post_id = ? ORDER BY ordem",
        [post.id],
      );
      post.midias = midias;
    }

    res.json({
      posts,
      hasMore: posts.length === limit,
      lastId: posts.length > 0 ? posts[posts.length - 1].id : null,
    });
  } catch (err) {
    console.error("[/api/gymsquads/:id/feed]", err.message);
    res.json({ posts: [], hasMore: false });
  }
});

// Vincular um post existente (do próprio usuário) ao feed do gymsquad
router.post("/api/gymsquads/:id/posts", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  const postId = parseInt(req.body.post_id, 10);
  if (!gymsquadId || !postId)
    return res.status(400).json({ ok: false, erro: "Dados inválidos." });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro)
      return res
        .status(403)
        .json({ ok: false, erro: "Não é membro deste gymsquad." });

    const [[post]] = await db.execute(
      "SELECT id FROM post WHERE id = ? AND user_id = ?",
      [postId, userId],
    );
    if (!post) return res.json({ ok: false, erro: "Post não encontrado." });

    await db.execute(
      "INSERT IGNORE INTO gymsquad_post (gymsquad_id, post_id) VALUES (?, ?)",
      [gymsquadId, postId],
    );

    const [[gr]] = await db.execute(
      "SELECT tipo_desafio FROM gymsquad WHERE id = ?",
      [gymsquadId],
    );
    if (gr?.tipo_desafio === "personalizado") {
      await recalcularPontuacao(gymsquadId, userId);
      await pushPlacar(gymsquadId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/gymsquads/:id/posts]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Posts recentes do próprio usuário ainda não vinculados a este gymsquad
// (usado no desafio "personalizado" pra escolher qual post vira a "prova")
router.get("/api/gymsquads/:id/meus-posts", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  if (!gymsquadId) return res.json({ posts: [] });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro) return res.json({ posts: [] });

    const [posts] = await db.execute(
      `SELECT p.id, p.legenda, p.tipo, p.created_at
       FROM post p
       WHERE p.user_id = ? AND p.status = 'ativo'
         AND p.id NOT IN (SELECT post_id FROM gymsquad_post WHERE gymsquad_id = ?)
       ORDER BY p.id DESC
       LIMIT 12`,
      [userId, gymsquadId],
    );
    for (const post of posts) {
      const [[midia]] = await db.execute(
        "SELECT url, tipo FROM post_midia WHERE post_id = ? ORDER BY ordem LIMIT 1",
        [post.id],
      );
      post.thumb = midia || null;
    }
    res.json({ posts });
  } catch (err) {
    console.error("[/api/gymsquads/:id/meus-posts]", err.message);
    res.json({ posts: [] });
  }
});

// Registrar km do dia (desafio tipo distância — auto-declarado, sem GPS)
router.post("/api/gymsquads/:id/distancia", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  const km = parseFloat(req.body.km);
  const data = req.body.data;
  if (!gymsquadId || !km || km <= 0 || km > 200 || !data) {
    return res.status(400).json({ ok: false, erro: "Dados inválidos." });
  }

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro)
      return res
        .status(403)
        .json({ ok: false, erro: "Não é membro deste gymsquad." });

    const [[gymsquad]] = await db.execute(
      "SELECT tipo_desafio, data_inicio, data_fim FROM gymsquad WHERE id = ? AND status = 'ativo'",
      [gymsquadId],
    );
    if (!gymsquad || gymsquad.tipo_desafio !== "distancia") {
      return res
        .status(400)
        .json({ ok: false, erro: "Este gymsquad não aceita registro de km." });
    }
    // Compara strings YYYY-MM-DD diretamente — evita ambiguidade de fuso ao
    // converter DATE (retornado como Date pelo mysql2) via Date.parse.
    const toISODate = (v) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const dataInicioStr = toISODate(gymsquad.data_inicio);
    const dataFimStr = toISODate(gymsquad.data_fim);
    const hojeStr = new Date().toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(data) ||
      data < dataInicioStr ||
      data > dataFimStr ||
      data > hojeStr
    ) {
      return res.status(400).json({ ok: false, erro: "Data inválida." });
    }

    await db.execute(
      `INSERT INTO gymsquad_distancia (gymsquad_id, user_id, km, data)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE km = VALUES(km)`,
      [gymsquadId, userId, km, data],
    );

    await recalcularPontuacao(gymsquadId, userId);
    const placar = await pushPlacar(gymsquadId);

    res.json({ ok: true, placar });
  } catch (err) {
    console.error("[/api/gymsquads/:id/distancia]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Forçar recálculo do placar (botão manual de atualizar)
router.post("/api/gymsquads/:id/recalcular", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  if (!gymsquadId) return res.status(400).json({ ok: false });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
      [gymsquadId, userId],
    );
    if (!membro) return res.status(403).json({ ok: false });

    await recalcularPontuacao(gymsquadId, userId);
    const placar = await pushPlacar(gymsquadId);

    res.json({ ok: true, placar });
  } catch (err) {
    console.error("[/api/gymsquads/:id/recalcular]", err.message);
    res.status(500).json({ ok: false });
  }
});

// Encerrar gymsquad (só admin) — recalcula todos, define vencedor, notifica
router.post("/api/gymsquads/:id/encerrar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const gymsquadId = parseInt(req.params.id, 10);
  if (!gymsquadId) return res.status(400).json({ ok: false });

  try {
    const [[admin]] = await db.execute(
      'SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ? AND role = "admin"',
      [gymsquadId, userId],
    );
    if (!admin)
      return res
        .status(403)
        .json({ ok: false, erro: "Apenas o admin pode encerrar." });

    const [membros] = await db.execute(
      "SELECT user_id FROM gymsquad_membro WHERE gymsquad_id = ?",
      [gymsquadId],
    );
    for (const { user_id } of membros) {
      await recalcularPontuacao(gymsquadId, user_id);
    }

    const placar = await buscarPlacar(gymsquadId);
    const vencedor = placar[0] || null;

    await db.execute(
      'UPDATE gymsquad SET status = "encerrado", vencedor_id = ? WHERE id = ?',
      [vencedor?.user_id || null, gymsquadId],
    );

    for (const { user_id } of membros) {
      await criarNotificacao(
        user_id,
        "gymsquad_encerrado",
        "GymSquad encerrado!",
        vencedor?.user_id === user_id
          ? "🏆 Você venceu o desafio!"
          : `O vencedor foi ${vencedor?.nome || "alguém"}`,
        { gymsquad_id: gymsquadId },
      );
    }

    res.json({ ok: true, vencedor });
  } catch (err) {
    console.error("[/api/gymsquads/:id/encerrar]", err.message);
    res.status(500).json({ ok: false });
  }
});

// ─── F14: Moderação — lado do usuário (apelação) ────────────────────────────

router.get("/conta-suspensa", requireAuth, (req, res) => {
  res.render("pages/conta-suspensa", {
    user: req.session.user,
    motivo: req.session.user.motivo_suspensao,
    suspenso_ate: req.session.user.suspenso_ate,
    seo: { title: "Conta suspensa", robots: "noindex" },
  });
});

router.get("/conta-banida", requireAuth, (req, res) => {
  res.render("pages/conta-banida", {
    user: req.session.user,
    motivo: req.session.user.motivo_suspensao,
    seo: { title: "Conta banida", robots: "noindex" },
  });
});

router.post("/api/apelacao", requireAuth, async (req, res) => {
  const { mensagem } = req.body;
  const userId = req.session.user.id;
  const status = req.session.user.status_conta;

  if (!["suspenso", "banido"].includes(status))
    return res.json({ ok: false, erro: "Sua conta não está suspensa ou banida." });

  const mensagemLimpa = typeof mensagem === "string" ? mensagem.trim() : "";
  if (mensagemLimpa.length < 10)
    return res.json({ ok: false, erro: "Mensagem muito curta." });

  try {
    const [[jaTem]] = await db.execute(
      "SELECT id FROM apelacao WHERE user_id = ? AND status = 'pendente'",
      [userId],
    );
    if (jaTem)
      return res.json({ ok: false, erro: "Você já tem uma apelação em análise." });

    await db.execute(
      `INSERT INTO apelacao (user_id, tipo_acao, mensagem)
       VALUES (?, ?, ?)`,
      [
        userId,
        status === "banido" ? "banimento" : "suspensao",
        mensagemLimpa.slice(0, 1000),
      ],
    );

    res.json({ ok: true, mensagem: "Apelação enviada. Analisaremos em breve." });
  } catch (err) {
    console.error("[/api/apelacao]", err.message);
    res.status(500).json({ ok: false, erro: "Erro ao enviar apelação." });
  }
});

// GET /api/amizades/lista — amigos aceitos em JSON (usado pelo picker do chat)
router.get("/api/amizades/lista", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const [amigos] = await db.execute(
      `
            SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil
            FROM friendship f
            JOIN user u ON u.id = IF(f.solicitante_id = ?, f.destinatario_id, f.solicitante_id)
            WHERE (f.solicitante_id = ? OR f.destinatario_id = ?)
              AND f.status = 'aceito'
              AND u.status = 'ativo'
            ORDER BY u.nome
        `,
      [uid, uid, uid],
    );
    res.json({ amigos });
  } catch (err) {
    console.error("[/api/amizades/lista]", err.message);
    res.json({ amigos: [] });
  }
});

// ─── Chat direto + grupos ────────────────────────────────────────────────────

// GET /chat — lista de conversas
router.get("/chat", requireAuth, (req, res) => {
  res.render("pages/chat", {
    user: req.session.user,
    conversaAtualId: null,
    seo: { title: "Chat — FitCrew", canonical: "/chat", robots: "noindex, nofollow" },
  });
});

// GET /chat/:conversaId — abre uma conversa específica
router.get("/chat/:conversaId", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const conversaId = parseInt(req.params.conversaId, 10);
  if (!conversaId) return res.redirect("/chat");
  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM chat_membro WHERE conversa_id = ? AND user_id = ?",
      [conversaId, userId],
    );
    if (!membro) return res.redirect("/chat");
  } catch (err) {
    console.error("[/chat/:id]", err.message);
    return res.redirect("/chat");
  }
  res.render("pages/chat", {
    user: req.session.user,
    conversaAtualId: conversaId,
    seo: { title: "Chat — FitCrew", canonical: "/chat", robots: "noindex, nofollow" },
  });
});

// GET /api/chat/conversas — lista de conversas do usuário, com última mensagem e não lidas
router.get("/api/chat/conversas", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [conversas] = await db.execute(
      `
      SELECT
        cc.id, cc.tipo, cc.nome, cc.foto, cc.updated_at,
        cm.tipo AS ultima_msg_tipo,
        cm.conteudo AS ultima_msg,
        cm.created_at AS ultima_msg_at,
        cm.user_id AS ultima_msg_user_id,
        (
          SELECT COUNT(*) FROM chat_mensagem x
           WHERE x.conversa_id = cc.id AND x.user_id != ? AND x.status = 'ativo'
             AND (mb.ultima_leitura IS NULL OR x.created_at > mb.ultima_leitura)
        ) AS nao_lidas,
        u2.id AS outro_id, u2.nome AS outro_nome,
        u2.username AS outro_username, u2.profile_photo AS outro_foto
      FROM chat_conversa cc
      JOIN chat_membro mb ON mb.conversa_id = cc.id AND mb.user_id = ?
      LEFT JOIN chat_mensagem cm ON cm.id = (
        SELECT id FROM chat_mensagem
         WHERE conversa_id = cc.id AND status = 'ativo'
         ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN chat_membro mb2 ON mb2.conversa_id = cc.id
        AND mb2.user_id != ? AND cc.tipo = 'individual'
      LEFT JOIN user u2 ON u2.id = mb2.user_id
      ORDER BY cc.updated_at DESC
      `,
      [userId, userId, userId],
    );
    res.json({ conversas });
  } catch (err) {
    console.error("[/api/chat/conversas]", err.message);
    res.json({ conversas: [] });
  }
});

// GET /api/chat/conversas/:id/mensagens — histórico paginado por cursor (id da mais antiga carregada)
router.get("/api/chat/conversas/:id/mensagens", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const conversaId = parseInt(req.params.id, 10);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  const limit = 50;
  if (!conversaId) return res.json({ mensagens: [] });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM chat_membro WHERE conversa_id = ? AND user_id = ?",
      [conversaId, userId],
    );
    if (!membro) return res.status(403).json({ mensagens: [] });

    const cursorSql = before ? "AND cm.id < ?" : "";
    const params = before ? [conversaId, before] : [conversaId];
    const [mensagens] = await db.execute(
      `
      SELECT cm.id, cm.tipo, cm.conteudo, cm.duracao, cm.user_id, cm.created_at,
             u.nome AS autor_nome, u.username AS autor_username, u.profile_photo AS autor_foto
        FROM chat_mensagem cm
        JOIN user u ON u.id = cm.user_id
       WHERE cm.conversa_id = ? AND cm.status = 'ativo' ${cursorSql}
       ORDER BY cm.id DESC
       LIMIT ${limit}
      `,
      params,
    );

    await db.execute(
      "UPDATE chat_membro SET ultima_leitura = NOW() WHERE conversa_id = ? AND user_id = ?",
      [conversaId, userId],
    );

    // Até quando os OUTROS membros já leram — permite marcar ✓✓ mesmo em
    // mensagens lidas enquanto o remetente não estava com a conversa aberta.
    const [[leitura]] = await db.execute(
      `SELECT MAX(ultima_leitura) AS lido_ate
         FROM chat_membro
        WHERE conversa_id = ? AND user_id != ? AND ultima_leitura IS NOT NULL`,
      [conversaId, userId],
    );

    res.json({
      mensagens: mensagens.reverse(),
      hasMore: mensagens.length === limit,
      lido_ate: leitura?.lido_ate || null,
    });
  } catch (err) {
    console.error("[/api/chat/conversas/:id/mensagens]", err.message);
    res.json({ mensagens: [] });
  }
});

// POST /api/chat/conversas — cria (ou retorna) a conversa individual com um amigo
router.post("/api/chat/conversas", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const amigoId = parseInt(req.body.user_id, 10);
  if (!amigoId || amigoId === userId)
    return res.status(400).json({ ok: false, erro: "Usuário inválido." });

  try {
    if (!(await saoAmigos(userId, amigoId)))
      return res.status(403).json({ ok: false, erro: "Vocês precisam ser amigos." });

    const [[existente]] = await db.execute(
      `SELECT cc.id FROM chat_conversa cc
         JOIN chat_membro m1 ON m1.conversa_id = cc.id AND m1.user_id = ?
         JOIN chat_membro m2 ON m2.conversa_id = cc.id AND m2.user_id = ?
        WHERE cc.tipo = 'individual'
        LIMIT 1`,
      [userId, amigoId],
    );
    if (existente) return res.json({ ok: true, conversaId: existente.id });

    const [result] = await db.execute("INSERT INTO chat_conversa (tipo) VALUES ('individual')");
    const conversaId = result.insertId;
    await db.execute(
      "INSERT INTO chat_membro (conversa_id, user_id) VALUES (?, ?), (?, ?)",
      [conversaId, userId, conversaId, amigoId],
    );

    res.json({ ok: true, conversaId });
  } catch (err) {
    console.error("[/api/chat/conversas POST]", err.message);
    res.status(500).json({ ok: false, erro: "Erro ao criar conversa." });
  }
});

// POST /api/chat/grupos — cria grupo com amigos aceitos como membros
router.post("/api/chat/grupos", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const nome = typeof req.body.nome === "string" ? req.body.nome.trim().slice(0, 100) : "";
  const membrosRaw = Array.isArray(req.body.membros) ? req.body.membros : [];

  if (!nome) return res.status(400).json({ ok: false, erro: "Nome do grupo obrigatório." });

  const candidatos = [...new Set(membrosRaw.map((id) => parseInt(id, 10)))].filter(
    (id) => id && id !== userId,
  );

  try {
    const validos = [];
    for (const uid of candidatos) {
      if (await saoAmigos(userId, uid)) validos.push(uid);
    }
    if (!validos.length)
      return res.status(400).json({ ok: false, erro: "Adicione pelo menos um amigo ao grupo." });

    const [result] = await db.execute(
      "INSERT INTO chat_conversa (tipo, nome, criador_id) VALUES ('grupo', ?, ?)",
      [nome, userId],
    );
    const conversaId = result.insertId;
    await db.execute(
      "INSERT INTO chat_membro (conversa_id, user_id, role) VALUES (?, ?, 'admin')",
      [conversaId, userId],
    );
    for (const uid of validos) {
      await db.execute(
        "INSERT IGNORE INTO chat_membro (conversa_id, user_id) VALUES (?, ?)",
        [conversaId, uid],
      );
    }

    res.json({ ok: true, conversaId });
  } catch (err) {
    console.error("[/api/chat/grupos]", err.message);
    res.status(500).json({ ok: false, erro: "Erro ao criar grupo." });
  }
});

// GET /api/chat/conversas/:id/midias — fotos enviadas na conversa (painel de informações)
router.get("/api/chat/conversas/:id/midias", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const conversaId = parseInt(req.params.id, 10);
  if (!conversaId) return res.json({ midias: [] });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM chat_membro WHERE conversa_id = ? AND user_id = ?",
      [conversaId, userId],
    );
    if (!membro) return res.status(403).json({ midias: [] });

    const [midias] = await db.execute(
      `SELECT conteudo, created_at FROM chat_mensagem
        WHERE conversa_id = ? AND tipo = 'foto' AND status = 'ativo'
        ORDER BY created_at DESC
        LIMIT 30`,
      [conversaId],
    );

    res.json({ midias });
  } catch (err) {
    console.error("[/api/chat/conversas/:id/midias]", err.message);
    res.json({ midias: [] });
  }
});

// GET /api/chat/conversas/:id/buscar?q=termo — busca mensagens de texto na conversa
router.get("/api/chat/conversas/:id/buscar", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const conversaId = parseInt(req.params.id, 10);
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!conversaId || !q) return res.json({ mensagens: [] });

  try {
    const [[membro]] = await db.execute(
      "SELECT id FROM chat_membro WHERE conversa_id = ? AND user_id = ?",
      [conversaId, userId],
    );
    if (!membro) return res.status(403).json({ mensagens: [] });

    const [mensagens] = await db.execute(
      `SELECT id, conteudo, created_at FROM chat_mensagem
        WHERE conversa_id = ?
          AND tipo = 'texto'
          AND status = 'ativo'
          AND conteudo LIKE ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [conversaId, `%${q}%`],
    );

    res.json({ mensagens });
  } catch (err) {
    console.error("[/api/chat/conversas/:id/buscar]", err.message);
    res.json({ mensagens: [] });
  }
});

// POST /api/chat/mensagens/midia — upload de foto/áudio (Cloudinary, sem gravar em disco)
router.post(
  "/api/chat/mensagens/midia",
  requireAuth,
  limiterUpload,
  uploadChat.single("midia"),
  async (req, res) => {
    const userId = req.session.user.id;
    if (!req.file) return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado." });

    const isAudio = req.file.mimetype.startsWith("audio/");
    const pasta = isAudio ? "gymbros/chat/audios" : "gymbros/chat/fotos";

    try {
      const resultado = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: pasta,
            resource_type: isAudio ? "video" : "image",
            transformation: isAudio
              ? []
              : [
                  { width: 1600, height: 1600, crop: "limit" },
                  { quality: "auto", fetch_format: "auto" },
                ],
          },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
        stream.end(req.file.buffer);
      });

      if (!isAudio) {
        const mod = await moderarImagem(resultado.secure_url);
        if (mod.decisao === "rejeitado") {
          await cloudinary.uploader.destroy(resultado.public_id, { resource_type: "image" });
          return res.json({ ok: false, erro: "Imagem contém conteúdo não permitido." });
        }
      }

      registrarMidiaAprovada(userId, resultado.public_id, resultado.secure_url);

      res.json({
        ok: true,
        url: resultado.secure_url,
        public_id: resultado.public_id,
        tipo: isAudio ? "audio" : "foto",
      });
    } catch (err) {
      console.error("[/api/chat/mensagens/midia]", err.message);
      res.status(500).json({ ok: false, erro: "Erro no upload." });
    }
  },
);

// ─── F4: Amizades ────────────────────────────────────────────────────────────

router.post(
  "/api/amizades/solicitar/:userId",
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.session.user.id;
      const alvoId = parseInt(req.params.userId, 10);
      if (uid === alvoId)
        return res.json({ ok: false, erro: "Você não pode se adicionar" });

      const [exists] = await db.execute(
        `SELECT id, status FROM friendship
             WHERE (solicitante_id = ? AND destinatario_id = ?)
                OR (solicitante_id = ? AND destinatario_id = ?)`,
        [uid, alvoId, alvoId, uid],
      );
      if (exists.length)
        return res.json({
          ok: false,
          erro: "Relação já existe",
          status: exists[0].status,
        });

      const [alvoRows] = await db.execute(
        'SELECT id, nome FROM user WHERE id = ? AND status = "ativo"',
        [alvoId],
      );
      if (!alvoRows.length)
        return res.json({ ok: false, erro: "Usuário não encontrado" });

      await db.execute(
        "INSERT INTO friendship (solicitante_id, destinatario_id) VALUES (?, ?)",
        [uid, alvoId],
      );
      await criarNotificacao(
        alvoId,
        "solicitacao_amizade",
        "Nova solicitação de amizade",
        `${req.session.user.nome} quer ser seu amigo`,
        { solicitante_id: uid, solicitante_nome: req.session.user.nome },
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/amizades/solicitar]", err.message);
      res.json({ ok: false, erro: "Erro interno" });
    }
  },
);

router.post("/api/amizades/:id/aceitar", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const fid = parseInt(req.params.id, 10);
    const [rows] = await db.execute(
      'SELECT * FROM friendship WHERE id = ? AND destinatario_id = ? AND status = "pendente"',
      [fid, uid],
    );
    if (!rows.length)
      return res.json({ ok: false, erro: "Solicitação não encontrada" });

    await db.execute('UPDATE friendship SET status = "aceito" WHERE id = ?', [
      fid,
    ]);
    await criarNotificacao(
      rows[0].solicitante_id,
      "amizade_aceita",
      "Solicitação aceita",
      `${req.session.user.nome} aceitou seu pedido de amizade`,
      { amigo_id: uid, amigo_nome: req.session.user.nome },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/amizades/aceitar]", err.message);
    res.json({ ok: false, erro: "Erro interno" });
  }
});

router.post("/api/amizades/:id/recusar", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const fid = parseInt(req.params.id, 10);
    await db.execute(
      'DELETE FROM friendship WHERE id = ? AND destinatario_id = ? AND status = "pendente"',
      [fid, uid],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/amizades/recusar]", err.message);
    res.json({ ok: false, erro: "Erro interno" });
  }
});

router.post("/api/amizades/:userId/bloquear", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const alvoId = parseInt(req.params.userId, 10);
    const [exists] = await db.execute(
      `SELECT id FROM friendship
             WHERE (solicitante_id = ? AND destinatario_id = ?)
                OR (solicitante_id = ? AND destinatario_id = ?)`,
      [uid, alvoId, alvoId, uid],
    );
    if (exists.length) {
      await db.execute(
        `UPDATE friendship SET status = 'bloqueado', solicitante_id = ?, destinatario_id = ?
                 WHERE id = ?`,
        [uid, alvoId, exists[0].id],
      );
    } else {
      await db.execute(
        "INSERT INTO friendship (solicitante_id, destinatario_id, status) VALUES (?, ?, 'bloqueado')",
        [uid, alvoId],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/amizades/bloquear]", err.message);
    res.json({ ok: false, erro: "Erro interno" });
  }
});

router.post("/api/usuarios/:id/denunciar", requireAuth, async (req, res) => {
  const motivosValidos = ["obsceno", "spam", "violencia", "fake", "outro"];
  const motivo = motivosValidos.includes(req.body.motivo) ? req.body.motivo : "outro";
  const alvoId = parseInt(req.params.id, 10);
  if (!alvoId || alvoId === req.session.user.id)
    return res.json({ ok: false, erro: "Usuário inválido." });

  try {
    await db.execute(
      `INSERT INTO denuncia (denunciante, tipo_alvo, alvo_id, motivo, descricao)
             VALUES (?, 'usuario', ?, ?, ?)`,
      [
        req.session.user.id,
        alvoId,
        motivo,
        (req.body.descricao || "").slice(0, 500) || null,
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/usuarios/:id/denunciar]", err.message);
    res.json({ ok: false, erro: "Erro ao denunciar." });
  }
});

router.delete("/api/amizades/:userId", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const alvoId = parseInt(req.params.userId, 10);
    await db.execute(
      `DELETE FROM friendship
             WHERE (solicitante_id = ? AND destinatario_id = ?)
                OR (solicitante_id = ? AND destinatario_id = ?)`,
      [uid, alvoId, alvoId, uid],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/amizades/delete]", err.message);
    res.json({ ok: false, erro: "Erro interno" });
  }
});

// ─── F9: Notificações Sociais ─────────────────────────────────────────────────

router.get("/api/notificacoes/sociais/stream", limiterSSE, requireAuth, (req, res) => {
  const uid = String(req.session.user.id);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  registerUserSSE(uid, res);
  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    unregisterUserSSE(uid);
  });
});

router.get("/api/notificacoes/sociais/count", requireAuth, async (req, res) => {
  try {
    const [[{ total }]] = await db.execute(
      "SELECT COUNT(*) AS total FROM notificacao_social WHERE usuario_id = ? AND lida = 0",
      [req.session.user.id],
    );
    res.json({ total });
  } catch (err) {
    console.error("[/api/notificacoes/count]", err.message);
    res.json({ total: 0 });
  }
});

router.get("/api/notificacoes/sociais", requireAuth, async (req, res) => {
  try {
    const [notifs] = await db.execute(
      `SELECT id, tipo, titulo, mensagem, lida, dados_extras, criado_em
             FROM notificacao_social
             WHERE usuario_id = ?
             ORDER BY criado_em DESC LIMIT 30`,
      [req.session.user.id],
    );
    res.json({ notificacoes: notifs });
  } catch (err) {
    console.error("[/api/notificacoes/sociais]", err.message);
    res.json({ notificacoes: [] });
  }
});

router.post(
  "/api/notificacoes/sociais/ler/:id",
  requireAuth,
  async (req, res) => {
    try {
      await db.execute(
        "UPDATE notificacao_social SET lida = 1 WHERE id = ? AND usuario_id = ?",
        [parseInt(req.params.id, 10), req.session.user.id],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/notificacoes/ler]", err.message);
      res.json({ ok: false });
    }
  },
);

router.post(
  "/api/notificacoes/sociais/ler-todas",
  requireAuth,
  async (req, res) => {
    try {
      await db.execute(
        "UPDATE notificacao_social SET lida = 1 WHERE usuario_id = ? AND lida = 0",
        [req.session.user.id],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/notificacoes/ler-todas]", err.message);
      res.json({ ok: false });
    }
  },
);

// ─── F5: Posts (feed) ───────────────────────────────────────────────────────

router.post(
  "/api/posts",
  requireAuth,
  limiterUpload,
  uploadPost.array("midias", 10),
  async (req, res) => {
    const userId = req.session.user.id;
    const legenda = (req.body.legenda || "").trim();
    const visibilidade = ["publico", "amigos", "privado"].includes(
      req.body.visibilidade,
    )
      ? req.body.visibilidade
      : "amigos";
    const arquivos = req.files || [];

    if (!legenda && arquivos.length === 0) {
      return res.json({ ok: false, erro: "Post precisa de legenda ou mídia." });
    }

    try {
      if (legenda) {
        const modTexto = await moderarTexto(legenda, "post");
        if (modTexto.decisao === "rejeitado") {
          return res.json({
            ok: false,
            erro: "Legenda contém conteúdo não permitido.",
          });
        }
      }

      const tipoPost =
        arquivos.length === 0
          ? "texto"
          : arquivos.length > 1
            ? "carrossel"
            : arquivos[0].mimetype.startsWith("video")
              ? "video"
              : "foto";

      const midias = [];
      for (let i = 0; i < arquivos.length; i++) {
        const arquivo = arquivos[i];
        const isVideo = arquivo.mimetype.startsWith("video");
        const pasta = isVideo ? "gymbros/posts/videos" : "gymbros/posts/fotos";

        const resultado = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: pasta,
              resource_type: isVideo ? "video" : "image",
              transformation: isVideo
                ? []
                : [
                    { width: 1080, height: 1080, crop: "limit" },
                    { quality: "auto", fetch_format: "auto" },
                  ],
            },
            (err, result) => (err ? reject(err) : resolve(result)),
          );
          stream.end(arquivo.buffer);
        });

        const modMidia = isVideo
          ? await moderarVideo(resultado.secure_url)
          : await moderarImagem(resultado.secure_url);

        if (modMidia.decisao === "rejeitado") {
          await cloudinary.uploader.destroy(resultado.public_id, {
            resource_type: isVideo ? "video" : "image",
          });
          return res.json({
            ok: false,
            erro: "Uma ou mais mídias contêm conteúdo não permitido.",
          });
        }

        midias.push({
          url: resultado.secure_url,
          public_id: resultado.public_id,
          tipo: isVideo ? "video" : "foto",
          ordem: i,
          largura: resultado.width || null,
          altura: resultado.height || null,
          revisao: modMidia.decisao === "revisao",
        });
      }

      const statusPost = midias.some((m) => m.revisao) ? "em_revisao" : "ativo";

      const [result] = await db.execute(
        `INSERT INTO post (user_id, legenda, tipo, status, visibilidade, moderado)
                 VALUES (?, ?, ?, ?, ?, 1)`,
        [userId, legenda || null, tipoPost, statusPost, visibilidade],
      );
      const postId = result.insertId;

      for (const m of midias) {
        await db.execute(
          `INSERT INTO post_midia (post_id, url, public_id, tipo, ordem, largura, altura)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [postId, m.url, m.public_id, m.tipo, m.ordem, m.largura, m.altura],
        );
      }

      // Vincula ao feed de um GymSquad, se enviado — só quando o autor é membro
      const gymsquadId = parseInt(req.body.gymsquad_id, 10);
      if (gymsquadId) {
        const [[membroGymSquad]] = await db.execute(
          "SELECT id FROM gymsquad_membro WHERE gymsquad_id = ? AND user_id = ?",
          [gymsquadId, userId],
        );
        if (membroGymSquad) {
          await db.execute(
            "INSERT IGNORE INTO gymsquad_post (gymsquad_id, post_id) VALUES (?, ?)",
            [gymsquadId, postId],
          );
          const [[gr]] = await db.execute(
            "SELECT tipo_desafio FROM gymsquad WHERE id = ?",
            [gymsquadId],
          );
          if (gr?.tipo_desafio === "personalizado") {
            await recalcularPontuacao(gymsquadId, userId);
            await pushPlacar(gymsquadId);
          }
        }
      }

      res.json({
        ok: true,
        postId,
        status: statusPost,
        mensagem:
          statusPost === "em_revisao"
            ? "Post enviado para revisão e será publicado em breve."
            : "Post publicado com sucesso!",
      });
    } catch (err) {
      console.error("[POST /api/posts]", err.message);
      res.json({ ok: false, erro: "Erro ao publicar post." });
    }
  },
);

router.get("/api/posts/feed", requireAuth, async (req, res) => {
  try {
    const lastId = parseInt(req.query.last_id, 10) || null;
    const lastEventId = parseInt(req.query.last_event_id, 10) || null;
    const feedData = await buscarFeedPosts(
      req.session.user.id,
      lastId,
      lastEventId,
    );
    res.json(feedData);
  } catch (err) {
    console.error("[GET /api/posts/feed]", err.message);
    res.json({ items: [], hasMore: false });
  }
});

router.get("/api/posts/feed/novos", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const sincePostId = parseInt(req.query.since_post_id, 10) || 0;
  const sinceEventId = parseInt(req.query.since_event_id, 10) || 0;

  try {
    const amigosIds = await buscarAmigosIds(userId);
    const placeholders = amigosIds.map(() => "?").join(",");

    const [[{ totalPosts }]] = await db.execute(
      `
            SELECT COUNT(*) AS totalPosts FROM post p
            WHERE p.user_id IN (${placeholders})
              AND p.status = 'ativo'
              AND (p.user_id = ${Number(userId)} OR p.visibilidade != 'privado')
              AND p.id > ${sincePostId}
        `,
      amigosIds,
    );

    const [[{ totalEventos }]] = await db.execute(
      `
            SELECT COUNT(*) AS totalEventos FROM feed_event fe
            WHERE fe.user_id IN (${placeholders})
              AND fe.id > ${sinceEventId}
        `,
      amigosIds,
    );

    res.json({ total: totalPosts + totalEventos });
  } catch (err) {
    console.error("[GET /api/posts/feed/novos]", err.message);
    res.json({ total: 0 });
  }
});

router.post("/api/feed/evento", requireAuth, async (req, res) => {
  const { tipo, ref_id, ref_tipo, payload } = req.body;
  const tiposValidos = ["checkin", "treino", "conquista"];

  if (!tiposValidos.includes(tipo)) {
    return res.json({ ok: false, erro: "Tipo inválido." });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO feed_event (user_id, tipo, ref_id, ref_tipo, payload)
             VALUES (?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        tipo,
        parseInt(ref_id, 10) || null,
        ref_tipo ? String(ref_tipo).slice(0, 30) : null,
        payload ? JSON.stringify(payload) : null,
      ],
    );
    res.json({ ok: true, eventId: result.insertId });
  } catch (err) {
    console.error("[POST /api/feed/evento]", err.message);
    res.json({ ok: false, erro: "Erro ao compartilhar." });
  }
});

router.delete("/api/posts/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const postId = parseInt(req.params.id, 10);
  try {
    const [[post]] = await db.execute(
      "SELECT id FROM post WHERE id = ? AND user_id = ?",
      [postId, userId],
    );
    if (!post) return res.json({ ok: false, erro: "Post não encontrado." });

    const [midias] = await db.execute(
      "SELECT public_id, tipo FROM post_midia WHERE post_id = ?",
      [postId],
    );
    for (const m of midias) {
      if (!m.public_id) continue;
      try {
        await cloudinary.uploader.destroy(m.public_id, {
          resource_type: m.tipo === "video" ? "video" : "image",
        });
      } catch (_) {}
    }

    await db.execute("DELETE FROM post WHERE id = ?", [postId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/posts/:id]", err.message);
    res.json({ ok: false, erro: "Erro ao remover post." });
  }
});

router.post("/api/posts/:id/denunciar", requireAuth, async (req, res) => {
  const motivosValidos = ["obsceno", "spam", "violencia", "fake", "outro"];
  const motivo = motivosValidos.includes(req.body.motivo)
    ? req.body.motivo
    : "outro";
  try {
    await db.execute(
      `INSERT INTO denuncia (denunciante, tipo_alvo, alvo_id, motivo, descricao)
             VALUES (?, 'post', ?, ?, ?)`,
      [
        req.session.user.id,
        parseInt(req.params.id, 10),
        motivo,
        (req.body.descricao || "").slice(0, 500) || null,
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/posts/:id/denunciar]", err.message);
    res.json({ ok: false, erro: "Erro ao denunciar." });
  }
});

// ─── F6: Comentários + Reações ─────────────────────────────────────────────

router.get("/api/posts/:id/comentarios", requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const [comentarios] = await db.execute(
      `SELECT c.id, c.texto, c.mencoes, c.parent_id, c.created_at,
                    u.id AS autor_id, u.nome AS autor_nome,
                    u.username AS autor_username, u.profile_photo AS autor_foto
             FROM comentario c
             JOIN user u ON u.id = c.user_id
             WHERE c.post_id = ? AND c.status = 'ativo'
             ORDER BY c.created_at ASC
             LIMIT 50`,
      [postId],
    );
    res.json({ comentarios });
  } catch (err) {
    console.error("[GET /api/posts/:id/comentarios]", err.message);
    res.json({ comentarios: [] });
  }
});

router.post("/api/posts/:id/comentarios", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const postId = parseInt(req.params.id, 10);
  const texto = (req.body.texto || "").trim();
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;

  if (!texto || texto.length > 1000) {
    return res.json({
      ok: false,
      erro: "Comentário deve ter entre 1 e 1000 caracteres.",
    });
  }

  try {
    const modTexto = await moderarTexto(texto, "comentario");
    if (modTexto.decisao === "rejeitado") {
      return res.json({
        ok: false,
        erro: "Comentário contém conteúdo não permitido.",
      });
    }

    const usernames = [...texto.matchAll(/@([a-z0-9_]+)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    let mencionados = [];
    if (usernames.length) {
      const placeholders = usernames.map(() => "?").join(",");
      const [rows] = await db.execute(
        `SELECT id, username FROM user WHERE username IN (${placeholders}) AND status = 'ativo'`,
        usernames,
      );
      mencionados = rows;
    }

    const [result] = await db.execute(
      `INSERT INTO comentario (post_id, user_id, parent_id, texto, mencoes)
             VALUES (?, ?, ?, ?, ?)`,
      [
        postId,
        userId,
        parentId,
        texto,
        mencionados.length
          ? JSON.stringify(mencionados.map((m) => m.id))
          : null,
      ],
    );
    const comentarioId = result.insertId;

    await db.execute(
      "UPDATE post SET total_comentarios = total_comentarios + 1 WHERE id = ?",
      [postId],
    );

    const [[post]] = await db.execute("SELECT user_id FROM post WHERE id = ?", [
      postId,
    ]);
    if (post && post.user_id !== userId) {
      await criarNotificacao(
        post.user_id,
        "comentario",
        "Novo comentário",
        `${req.session.user.nome} comentou no seu post`,
        {
          post_id: postId,
          comentario_id: comentarioId,
          autor_id: userId,
          autor_nome: req.session.user.nome,
        },
      );
    }

    for (const mencionado of mencionados) {
      if (mencionado.id === userId) continue;
      await criarNotificacao(
        mencionado.id,
        "mencao",
        "Você foi mencionado",
        `${req.session.user.nome} mencionou você em um comentário`,
        {
          post_id: postId,
          comentario_id: comentarioId,
          autor_id: userId,
          autor_nome: req.session.user.nome,
        },
      );
    }

    res.json({
      ok: true,
      comentario: {
        id: comentarioId,
        texto,
        parent_id: parentId,
        created_at: new Date(),
        autor_id: userId,
        autor_nome: req.session.user.nome,
        autor_username: req.session.user.username || null,
        autor_foto: req.session.user.profile_photo || null,
      },
    });
  } catch (err) {
    console.error("[POST /api/posts/:id/comentarios]", err.message);
    res.json({ ok: false, erro: "Erro ao comentar." });
  }
});

router.delete("/api/comentarios/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const comentarioId = parseInt(req.params.id, 10);
  try {
    const [[comentario]] = await db.execute(
      'SELECT id, post_id FROM comentario WHERE id = ? AND user_id = ? AND status = "ativo"',
      [comentarioId, userId],
    );
    if (!comentario)
      return res.json({ ok: false, erro: "Comentário não encontrado." });

    await db.execute('UPDATE comentario SET status = "removido" WHERE id = ?', [
      comentarioId,
    ]);
    await db.execute(
      "UPDATE post SET total_comentarios = GREATEST(total_comentarios - 1, 0) WHERE id = ?",
      [comentario.post_id],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/comentarios/:id]", err.message);
    res.json({ ok: false, erro: "Erro ao remover comentário." });
  }
});

router.post("/api/posts/:id/reagir", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const postId = parseInt(req.params.id, 10);
  const tiposValidos = ["fogo", "musculo", "surpresa", "parabens", "forca"];
  const tipo = req.body.tipo;

  if (!tiposValidos.includes(tipo)) {
    return res.json({ ok: false, erro: "Tipo de reação inválido." });
  }

  try {
    const [[post]] = await db.execute(
      'SELECT id, user_id FROM post WHERE id = ? AND status = "ativo"',
      [postId],
    );
    if (!post) return res.json({ ok: false, erro: "Post não encontrado." });

    const [existente] = await db.execute(
      "SELECT tipo FROM reacao WHERE post_id = ? AND user_id = ?",
      [postId, userId],
    );

    await db.execute(
      `INSERT INTO reacao (post_id, user_id, tipo) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE tipo = VALUES(tipo)`,
      [postId, userId, tipo],
    );

    if (!existente.length) {
      await db.execute(
        "UPDATE post SET total_reacoes = total_reacoes + 1 WHERE id = ?",
        [postId],
      );
      if (post.user_id !== userId) {
        await criarNotificacao(
          post.user_id,
          "reacao",
          "Nova reação",
          `${req.session.user.nome} reagiu ao seu post`,
          {
            post_id: postId,
            tipo,
            autor_id: userId,
            autor_nome: req.session.user.nome,
          },
        );
      }
    }

    const [[{ total }]] = await db.execute(
      "SELECT total_reacoes AS total FROM post WHERE id = ?",
      [postId],
    );
    res.json({ ok: true, tipo, total_reacoes: total });
  } catch (err) {
    console.error("[POST /api/posts/:id/reagir]", err.message);
    res.json({ ok: false, erro: "Erro ao reagir." });
  }
});

router.delete("/api/posts/:id/reagir", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const postId = parseInt(req.params.id, 10);
  try {
    const [result] = await db.execute(
      "DELETE FROM reacao WHERE post_id = ? AND user_id = ?",
      [postId, userId],
    );
    if (result.affectedRows) {
      await db.execute(
        "UPDATE post SET total_reacoes = GREATEST(total_reacoes - 1, 0) WHERE id = ?",
        [postId],
      );
    }
    const [[{ total }]] = await db.execute(
      "SELECT total_reacoes AS total FROM post WHERE id = ?",
      [postId],
    );
    res.json({ ok: true, total_reacoes: total });
  } catch (err) {
    console.error("[DELETE /api/posts/:id/reagir]", err.message);
    res.json({ ok: false, erro: "Erro ao remover reação." });
  }
});

router.get("/api/posts/:id/reacoes", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const postId = parseInt(req.params.id, 10);
  try {
    const [rows] = await db.execute(
      "SELECT tipo, COUNT(*) AS total FROM reacao WHERE post_id = ? GROUP BY tipo",
      [postId],
    );
    const contagemPorTipo = {};
    let total = 0;
    for (const r of rows) {
      contagemPorTipo[r.tipo] = r.total;
      total += r.total;
    }

    const [[minha]] = await db.execute(
      "SELECT tipo FROM reacao WHERE post_id = ? AND user_id = ?",
      [postId, userId],
    );

    res.json({
      total,
      minha_reacao: minha ? minha.tipo : null,
      contagem_por_tipo: contagemPorTipo,
    });
  } catch (err) {
    console.error("[GET /api/posts/:id/reacoes]", err.message);
    res.json({ total: 0, minha_reacao: null, contagem_por_tipo: {} });
  }
});

// ─── F8: Stories (24h) ──────────────────────────────────────────────────────

router.post(
  "/api/stories",
  requireAuth,
  limiterUpload,
  uploadPost.single("midia"),
  async (req, res) => {
    const userId = req.session.user.id;
    const tipo = req.body.tipo;
    const tiposValidos = ["foto", "video", "texto"];
    if (!tiposValidos.includes(tipo)) {
      return res.json({ ok: false, erro: "Tipo inválido." });
    }

    try {
      let url = null,
        publicId = null,
        texto = null,
        corFundo = null;

      if (tipo === "texto") {
        texto = (req.body.texto || "").trim();
        if (!texto || texto.length > 500) {
          return res.json({
            ok: false,
            erro: "Texto do story deve ter entre 1 e 500 caracteres.",
          });
        }
        const modTexto = await moderarTexto(texto, "post");
        if (modTexto.decisao === "rejeitado") {
          return res.json({
            ok: false,
            erro: "Texto contém conteúdo não permitido.",
          });
        }
        const coresValidas = [
          "#1a1a1a",
          "#C98B1D",
          "#1e3a5f",
          "#2d1b69",
          "#1a3a1a",
        ];
        corFundo = coresValidas.includes(req.body.cor_fundo)
          ? req.body.cor_fundo
          : "#1a1a1a";
      } else {
        const arquivo = req.file;
        if (!arquivo)
          return res.json({ ok: false, erro: "Selecione uma foto ou vídeo." });
        const isVideo = arquivo.mimetype.startsWith("video");
        if ((tipo === "video") !== isVideo) {
          return res.json({
            ok: false,
            erro: "Tipo de arquivo não corresponde ao selecionado.",
          });
        }

        const resultado = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "gymbros/stories",
              resource_type: isVideo ? "video" : "image",
              transformation: isVideo
                ? []
                : [
                    { width: 1080, height: 1920, crop: "limit" },
                    { quality: "auto", fetch_format: "auto" },
                  ],
            },
            (err, result) => (err ? reject(err) : resolve(result)),
          );
          stream.end(arquivo.buffer);
        });

        // Moderação externa desativada para stories para permitir upload de vídeos sem depender de APIs externas.
        // A publicação continua normalmente mesmo se a validação externa falhar.
        url = resultado.secure_url;
        publicId = resultado.public_id;
      }

      const [result] = await db.execute(
        `INSERT INTO story (user_id, tipo, url, public_id, texto, cor_fundo, expira_em)
                 VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
        [userId, tipo, url, publicId, texto, corFundo],
      );

      res.json({ ok: true, storyId: result.insertId });
    } catch (err) {
      console.error("[POST /api/stories]", err.message);
      res.json({ ok: false, erro: "Erro ao publicar story." });
    }
  },
);

router.get("/api/stories/feed", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const amigosIds = (await buscarAmigosIds(userId)).filter(
      (id) => id !== userId,
    );
    const idsBusca = [userId, ...amigosIds];

    const placeholders = idsBusca.map(() => "?").join(",");
    const [stories] = await db.execute(
      `
            SELECT s.id, s.user_id, s.tipo, s.url, s.texto, s.cor_fundo, s.views, s.created_at,
                   u.nome AS user_nome, u.username AS user_username, u.profile_photo AS user_foto,
                   EXISTS(SELECT 1 FROM story_view sv WHERE sv.story_id = s.id AND sv.user_id = ?) AS visto
            FROM story s
            JOIN user u ON u.id = s.user_id
            WHERE s.user_id IN (${placeholders}) AND s.expira_em > NOW() AND s.status = 'ativo'
            ORDER BY s.user_id, s.created_at ASC
        `,
      [userId, ...idsBusca],
    );

    const gruposMap = new Map();
    for (const s of stories) {
      if (!gruposMap.has(s.user_id)) {
        gruposMap.set(s.user_id, {
          user_id: s.user_id,
          user_nome: s.user_nome,
          user_username: s.user_username,
          user_foto: s.user_foto,
          stories: [],
          total_stories: 0,
          total_vistos: 0,
          updated_at: s.created_at,
        });
      }
      const grupo = gruposMap.get(s.user_id);
      grupo.stories.push({
        id: s.id,
        tipo: s.tipo,
        url: s.url,
        texto: s.texto,
        cor_fundo: s.cor_fundo,
        views: s.views,
        created_at: s.created_at,
        visto: !!s.visto,
      });
      grupo.total_stories++;
      if (s.visto) grupo.total_vistos++;
      if (new Date(s.created_at) > new Date(grupo.updated_at))
        grupo.updated_at = s.created_at;
    }

    // Stories do próprio usuário saem à parte — o front já tem uma bolha
    // dedicada ("Seu story"), não devem duplicar dentro de `grupos`.
    const proprio = gruposMap.get(userId) || null;
    gruposMap.delete(userId);

    const grupos = [...gruposMap.values()].sort((a, b) => {
      const aVistoTudo = a.total_vistos >= a.total_stories;
      const bVistoTudo = b.total_vistos >= b.total_stories;
      if (aVistoTudo !== bVistoTudo) return aVistoTudo ? 1 : -1;
      return new Date(b.updated_at) - new Date(a.updated_at);
    });

    res.json({ grupos, proprio });
  } catch (err) {
    console.error("[GET /api/stories/feed]", err.message);
    res.json({ grupos: [], proprio: null });
  }
});

router.get("/api/stories/:userId", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const targetId = parseInt(req.params.userId, 10);
  try {
    const [stories] = await db.execute(
      `SELECT id, tipo, url, texto, cor_fundo, views, created_at
             FROM story WHERE user_id = ? AND expira_em > NOW() AND status = 'ativo'
             ORDER BY created_at ASC`,
      [targetId],
    );

    // Dono vendo o próprio story não conta como visualização
    if (targetId !== userId) {
      const novosVistos = [];
      for (const s of stories) {
        const [result] = await db.execute(
          "INSERT IGNORE INTO story_view (story_id, user_id) VALUES (?, ?)",
          [s.id, userId],
        );
        if (result.affectedRows > 0) novosVistos.push(s.id);
      }
      if (novosVistos.length) {
        const placeholders = novosVistos.map(() => "?").join(",");
        await db.execute(
          `UPDATE story SET views = views + 1 WHERE id IN (${placeholders})`,
          novosVistos,
        );
      }
    }

    res.json({ stories });
  } catch (err) {
    console.error("[GET /api/stories/:userId]", err.message);
    res.json({ stories: [] });
  }
});

router.post("/api/stories/:id/view", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const storyId = parseInt(req.params.id, 10);
  try {
    const [result] = await db.execute(
      "INSERT IGNORE INTO story_view (story_id, user_id) VALUES (?, ?)",
      [storyId, userId],
    );
    if (result.affectedRows > 0) {
      await db.execute("UPDATE story SET views = views + 1 WHERE id = ?", [
        storyId,
      ]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/stories/:id/view]", err.message);
    res.json({ ok: false });
  }
});

router.delete("/api/stories/:id", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const storyId = parseInt(req.params.id, 10);
  try {
    const [[story]] = await db.execute(
      "SELECT id, public_id, tipo FROM story WHERE id = ? AND user_id = ?",
      [storyId, userId],
    );
    if (!story) return res.json({ ok: false, erro: "Story não encontrado." });

    if (story.public_id) {
      try {
        await cloudinary.uploader.destroy(story.public_id, {
          resource_type: story.tipo === "video" ? "video" : "image",
        });
      } catch (_) {}
    }

    await db.execute("DELETE FROM story WHERE id = ?", [storyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/stories/:id]", err.message);
    res.json({ ok: false, erro: "Erro ao remover story." });
  }
});

router.get("/api/stories/:id/views", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const storyId = parseInt(req.params.id, 10);
  try {
    const [[story]] = await db.execute(
      "SELECT id, user_id, views FROM story WHERE id = ? LIMIT 1",
      [storyId],
    );
    if (!story || story.user_id !== userId) {
      return res.json({ ok: false, erro: "Não autorizado." });
    }

    const [visualizacoes] = await db.execute(
      `
            SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil, sv.viewed_at
            FROM story_view sv
            JOIN user u ON u.id = sv.user_id
            WHERE sv.story_id = ?
            ORDER BY sv.viewed_at DESC
        `,
      [storyId],
    );

    res.json({ ok: true, total: story.views, visualizacoes });
  } catch (err) {
    console.error("[GET /api/stories/:id/views]", err.message);
    res.json({ ok: false, erro: "Erro ao carregar visualizações." });
  }
});

module.exports = router;
