/**
 * mod.js — Painel de moderação (/mod), separado do admin.
 *
 * Um moderador é um `user` comum promovido via `role = 'moderador'` direto
 * no banco (não uma conta em admin_user/gym_admin, que têm tabela própria).
 * Mas a SESSÃO é independente: req.session.mod, não req.session.user — login
 * como aluno e login como moderador não se afetam, cada um com seu próprio
 * form de autenticação (POST /login vs POST /mod/login).
 */
'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../config/db');
const { limiterLogin } = require('../middleware/rateLimits');
const { criarNotificacao } = require('../services/notificacoes');

// Nunca selecionar estas colunas em nenhuma view de moderação.
const CAMPOS_SENSIVEIS = ['senha_hash', 'cpf_enc', 'cpf_hmac', 'webauthn_public_key', 'webauthn_credential_id'];
void CAMPOS_SENSIVEIS; // documentação viva — todas as queries abaixo usam SELECT explícito

// Contagens usadas nos badges da sidebar — chamado em toda rota de página.
async function badgeCounts() {
  try {
    const [[{ denuncias_pendentes }]] = await db.execute(
      "SELECT COUNT(*) AS denuncias_pendentes FROM denuncia WHERE status = 'pendente'",
    );
    const [[{ apelacoes_pendentes }]] = await db.execute(
      "SELECT COUNT(*) AS apelacoes_pendentes FROM apelacao WHERE status = 'pendente'",
    );
    return { denuncias_pendentes, apelacoes_pendentes };
  } catch (err) {
    console.error('[mod] badgeCounts:', err.message);
    return { denuncias_pendentes: 0, apelacoes_pendentes: 0 };
  }
}

function requireMod(req, res, next) {
  if (!req.session?.mod) return res.redirect('/mod/login');
  const role = req.session.mod.role;
  if (role !== 'moderador' && role !== 'admin') {
    return res.status(403).render('mod/acesso-negado', {
      seo: { title: 'Acesso negado', robots: 'noindex' },
    });
  }
  next();
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  const role = req.session?.mod?.role;
  if (role === 'moderador' || role === 'admin') return res.redirect('/mod');
  res.render('mod/login', {
    erro: null,
    seo: { title: 'Moderação — Login', robots: 'noindex' },
  });
});

router.post('/login', limiterLogin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('mod/login', {
      erro: 'Preencha todos os campos.',
      seo: { title: 'Moderação — Login', robots: 'noindex' },
    });
  }

  try {
    const [[user]] = await db.execute(
      `SELECT id, nome, username, email, senha_hash, role, status_conta, profile_photo
         FROM user
        WHERE (email = ? OR username = ?)
          AND role IN ('moderador', 'admin')
          AND status_conta = 'ativo'
        LIMIT 1`,
      [username, username],
    );

    if (!user || !(await bcrypt.compare(password, user.senha_hash))) {
      return res.render('mod/login', {
        erro: 'Credenciais inválidas ou sem permissão de moderação.',
        seo: { title: 'Moderação — Login', robots: 'noindex' },
      });
    }

    // Sessão separada do aluno — nunca reaproveita req.session.user.
    req.session.mod = {
      id: user.id,
      nome: user.nome,
      username: user.username,
      email: user.email,
      role: user.role,
      foto_perfil: user.profile_photo || null,
    };

    req.session.save((err) => {
      if (err) {
        console.error('[POST /mod/login] session save error:', err);
        return res.render('mod/login', {
          erro: 'Erro ao salvar sessão.',
          seo: { title: 'Moderação — Login', robots: 'noindex' },
        });
      }
      res.redirect('/mod');
    });
  } catch (err) {
    console.error('[POST /mod/login]', err.message);
    res.render('mod/login', {
      erro: 'Erro ao fazer login.',
      seo: { title: 'Moderação — Login', robots: 'noindex' },
    });
  }
});

router.post('/logout', (req, res) => {
  req.session.mod = null;
  req.session.save(() => res.redirect('/mod/login'));
});

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/', requireMod, async (req, res) => {
  try {
    const [[{ denuncias_pendentes }]] = await db.execute(
      "SELECT COUNT(*) AS denuncias_pendentes FROM denuncia WHERE status = 'pendente'",
    );
    const [[{ usuarios_suspensos }]] = await db.execute(
      `SELECT COUNT(*) AS usuarios_suspensos FROM user
        WHERE status_conta = 'suspenso' AND (suspenso_ate IS NULL OR suspenso_ate > NOW())`,
    );
    const [[{ usuarios_banidos }]] = await db.execute(
      "SELECT COUNT(*) AS usuarios_banidos FROM user WHERE status_conta = 'banido'",
    );
    const [[{ removidos_hoje }]] = await db.execute(
      "SELECT COUNT(*) AS removidos_hoje FROM mod_acao WHERE acao = 'remover' AND DATE(created_at) = CURDATE()",
    );
    const [[{ apelacoes_pendentes }]] = await db.execute(
      "SELECT COUNT(*) AS apelacoes_pendentes FROM apelacao WHERE status = 'pendente'",
    );

    const [top_denunciados] = await db.execute(`
      SELECT u.id, u.nome, u.username, u.profile_photo AS foto_perfil,
             COUNT(d.id) AS total_denuncias
        FROM denuncia d
        JOIN post p ON d.alvo_id = p.id AND d.tipo_alvo = 'post'
        JOIN user u ON u.id = p.user_id
       WHERE d.status = 'pendente'
       GROUP BY u.id, u.nome, u.username, u.profile_photo
       ORDER BY total_denuncias DESC
       LIMIT 5
    `);

    res.render('mod/dashboard', {
      mod: req.session.mod,
      stats: { denuncias_pendentes, usuarios_suspensos, usuarios_banidos, removidos_hoje, apelacoes_pendentes },
      top_denunciados,
      badges: { denuncias_pendentes, apelacoes_pendentes },
      page_ativa: 'dashboard',
      seo: { title: 'Painel de Moderação', robots: 'noindex' },
    });
  } catch (err) {
    console.error('[/mod]', err.message);
    res.status(500).send('Erro no painel de moderação.');
  }
});

// ── DENÚNCIAS ────────────────────────────────────────────────────────────────
router.get('/denuncias', requireMod, async (req, res) => {
  const status = ['pendente', 'resolvida', 'ignorada'].includes(req.query.status) ? req.query.status : 'pendente';
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit  = 20;
  const offset = (page - 1) * limit;

  try {
    const [denuncias] = await db.execute(
      `
      SELECT
        d.id, d.tipo_alvo, d.alvo_id, d.motivo, d.descricao, d.status, d.criado_em,
        u_den.id   AS denunciante_id,
        u_den.nome AS denunciante_nome,
        u_den.username AS denunciante_username,
        CASE d.tipo_alvo
          WHEN 'post'       THEN p.legenda
          WHEN 'comentario' THEN c.texto
          WHEN 'story'      THEN s.texto
          ELSE NULL
        END AS conteudo_texto,
        CASE d.tipo_alvo
          WHEN 'post'       THEN u_post.id
          WHEN 'comentario' THEN u_com.id
          WHEN 'story'      THEN u_sto.id
          ELSE NULL
        END AS autor_id,
        CASE d.tipo_alvo
          WHEN 'post'       THEN u_post.nome
          WHEN 'comentario' THEN u_com.nome
          WHEN 'story'      THEN u_sto.nome
          ELSE NULL
        END AS autor_nome,
        CASE d.tipo_alvo
          WHEN 'post'       THEN u_post.username
          WHEN 'comentario' THEN u_com.username
          WHEN 'story'      THEN u_sto.username
          ELSE NULL
        END AS autor_username
      FROM denuncia d
      JOIN user u_den ON u_den.id = d.denunciante
      LEFT JOIN post       p      ON d.tipo_alvo = 'post'       AND p.id = d.alvo_id
      LEFT JOIN user       u_post ON u_post.id = p.user_id
      LEFT JOIN comentario c      ON d.tipo_alvo = 'comentario' AND c.id = d.alvo_id
      LEFT JOIN user       u_com  ON u_com.id = c.user_id
      LEFT JOIN story      s      ON d.tipo_alvo = 'story'      AND s.id = d.alvo_id
      LEFT JOIN user       u_sto  ON u_sto.id = s.user_id
      WHERE d.status = ?
      ORDER BY d.criado_em DESC
      LIMIT ${limit} OFFSET ${offset}
      `,
      [status],
    );

    const [[{ total }]] = await db.execute(
      'SELECT COUNT(*) AS total FROM denuncia WHERE status = ?',
      [status],
    );

    res.render('mod/denuncias', {
      mod: req.session.mod,
      denuncias,
      status,
      page,
      totalPaginas: Math.ceil(total / limit) || 1,
      badges: await badgeCounts(),
      page_ativa: 'denuncias',
      seo: { title: 'Denúncias — Moderação', robots: 'noindex' },
    });
  } catch (err) {
    console.error('[/mod/denuncias]', err.message);
    res.status(500).send('Erro ao carregar denúncias.');
  }
});

// ── USUÁRIOS ─────────────────────────────────────────────────────────────────
router.get('/usuarios', requireMod, async (req, res) => {
  const q      = (req.query.q || '').trim();
  const filtro = ['suspensos', 'banidos'].includes(req.query.filtro) ? req.query.filtro : 'todos';
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit  = 20;
  const offset = (page - 1) * limit;

  try {
    let where = 'WHERE 1=1';
    const params = [];

    if (q) {
      where += ' AND (u.nome LIKE ? OR u.username LIKE ? OR u.email LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (filtro === 'suspensos') where += " AND u.status_conta = 'suspenso'";
    if (filtro === 'banidos')   where += " AND u.status_conta = 'banido'";

    const [usuarios] = await db.execute(
      `
      SELECT u.id, u.nome, u.username, u.email, u.profile_photo AS foto_perfil,
             u.status_conta, u.suspenso_ate, u.motivo_suspensao, u.role, u.created_at,
             COUNT(DISTINCT d.id) AS total_denuncias
        FROM user u
        LEFT JOIN post p ON p.user_id = u.id
        LEFT JOIN denuncia d ON d.alvo_id = p.id AND d.tipo_alvo = 'post' AND d.status = 'pendente'
        ${where}
        GROUP BY u.id, u.nome, u.username, u.email, u.profile_photo, u.status_conta,
                 u.suspenso_ate, u.motivo_suspensao, u.role, u.created_at
        ORDER BY total_denuncias DESC, u.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      params,
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM user u ${where}`,
      params,
    );

    res.render('mod/usuarios', {
      mod: req.session.mod,
      usuarios,
      q,
      filtro,
      page,
      totalPaginas: Math.ceil(total / limit) || 1,
      badges: await badgeCounts(),
      page_ativa: 'usuarios',
      seo: { title: 'Usuários — Moderação', robots: 'noindex' },
    });
  } catch (err) {
    console.error('[/mod/usuarios]', err.message);
    res.status(500).send('Erro ao carregar usuários.');
  }
});

// ── APELAÇÕES ────────────────────────────────────────────────────────────────
router.get('/apelacoes', requireMod, async (req, res) => {
  try {
    const [apelacoes] = await db.execute(`
      SELECT a.id, a.tipo_acao, a.mensagem, a.status, a.created_at,
             u.id AS user_id, u.nome, u.username, u.profile_photo AS foto_perfil,
             u.status_conta, u.suspenso_ate
        FROM apelacao a
        JOIN user u ON u.id = a.user_id
       WHERE a.status = 'pendente'
       ORDER BY a.created_at ASC
    `);

    res.render('mod/apelacoes', {
      mod: req.session.mod,
      apelacoes,
      badges: await badgeCounts(),
      page_ativa: 'apelacoes',
      seo: { title: 'Apelações — Moderação', robots: 'noindex' },
    });
  } catch (err) {
    console.error('[/mod/apelacoes]', err.message);
    res.status(500).send('Erro ao carregar apelações.');
  }
});

// ── API: ações sobre conteúdo (post/comentário/story) ────────────────────────
router.post('/api/acao/conteudo', requireMod, async (req, res) => {
  const { tipo, id, acao, motivo } = req.body;
  const modId = req.session.mod.id;

  const tiposValidos = ['post', 'comentario', 'story'];
  const acoesValidas = ['remover', 'ignorar_denuncia'];
  const alvoId = parseInt(id, 10);
  if (!tiposValidos.includes(tipo) || !acoesValidas.includes(acao) || !alvoId)
    return res.json({ ok: false, erro: 'Parâmetros inválidos.' });

  try {
    if (acao === 'remover') {
      const tabela = tipo === 'post' ? 'post' : tipo === 'comentario' ? 'comentario' : 'story';
      await db.execute(`UPDATE ${tabela} SET status = 'removido' WHERE id = ?`, [alvoId]);
      await db.execute(
        "UPDATE denuncia SET status = 'resolvida' WHERE tipo_alvo = ? AND alvo_id = ?",
        [tipo, alvoId],
      );
    } else {
      await db.execute(
        "UPDATE denuncia SET status = 'ignorada' WHERE tipo_alvo = ? AND alvo_id = ?",
        [tipo, alvoId],
      );
    }

    await db.execute(
      `INSERT INTO mod_acao (mod_id, alvo_tipo, alvo_id, acao, motivo) VALUES (?, ?, ?, ?, ?)`,
      [modId, tipo, alvoId, acao, (motivo || '').slice(0, 500) || null],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[/mod/api/acao/conteudo]', err.message);
    res.json({ ok: false, erro: 'Erro ao executar ação.' });
  }
});

// ── API: ações sobre usuário (suspender/banir/reativar/avisar) ───────────────
router.post('/api/acao/usuario', requireMod, async (req, res) => {
  const { user_id, acao, dias, motivo } = req.body;
  const modId = req.session.mod.id;
  const alvoUserId = parseInt(user_id, 10);

  const acoesValidas = ['suspender', 'banir', 'reativar', 'avisar'];
  if (!acoesValidas.includes(acao) || !alvoUserId)
    return res.json({ ok: false, erro: 'Parâmetros inválidos.' });

  try {
    const [[alvo]] = await db.execute(
      'SELECT id, role, nome FROM user WHERE id = ?',
      [alvoUserId],
    );
    if (!alvo) return res.json({ ok: false, erro: 'Usuário não encontrado.' });
    // Mod nunca age sobre outro mod ou admin — nem mesmo o próprio (evita autobanimento).
    if (alvo.role === 'admin' || alvo.role === 'moderador')
      return res.json({ ok: false, erro: 'Não é possível moderar este usuário.' });

    const motivoLimpo = (motivo || '').slice(0, 500) || null;

    if (acao === 'suspender') {
      const diasNum = [1, 3, 7, 30].includes(parseInt(dias, 10)) ? parseInt(dias, 10) : 1;
      await db.execute(
        `UPDATE user SET status_conta = 'suspenso',
           suspenso_ate = DATE_ADD(NOW(), INTERVAL ? DAY),
           motivo_suspensao = ?
         WHERE id = ?`,
        [diasNum, motivoLimpo, alvoUserId],
      );
    } else if (acao === 'banir') {
      await db.execute(
        "UPDATE user SET status_conta = 'banido', motivo_suspensao = ? WHERE id = ?",
        [motivoLimpo, alvoUserId],
      );
    } else if (acao === 'reativar') {
      await db.execute(
        "UPDATE user SET status_conta = 'ativo', suspenso_ate = NULL, motivo_suspensao = NULL WHERE id = ?",
        [alvoUserId],
      );
    }
    // 'avisar' não muda status_conta — só gera o log e a notificação abaixo.

    await db.execute(
      `INSERT INTO mod_acao (mod_id, alvo_user_id, alvo_tipo, acao, motivo) VALUES (?, ?, 'usuario', ?, ?)`,
      [modId, alvoUserId, acao, motivoLimpo],
    );

    const titulos = {
      suspender: 'Sua conta foi suspensa',
      banir: 'Sua conta foi banida',
      reativar: 'Sua conta foi reativada',
      avisar: 'Aviso da moderação',
    };
    const mensagens = {
      suspender: `Motivo: ${motivoLimpo || 'violação das diretrizes'}. Você pode enviar uma apelação.`,
      banir: `Motivo: ${motivoLimpo || 'violação grave das diretrizes'}. Você pode enviar uma apelação.`,
      reativar: 'Sua conta voltou a ficar ativa.',
      avisar: motivoLimpo || 'Revise as diretrizes da comunidade.',
    };
    await criarNotificacao(alvoUserId, 'moderacao', titulos[acao], mensagens[acao], { acao });

    res.json({ ok: true });
  } catch (err) {
    console.error('[/mod/api/acao/usuario]', err.message);
    res.json({ ok: false, erro: 'Erro ao executar ação.' });
  }
});

// ── API: responder apelação ───────────────────────────────────────────────────
router.post('/api/apelacao/:id/responder', requireMod, async (req, res) => {
  const { aceitar, resposta } = req.body;
  const apelacaoId = parseInt(req.params.id, 10);
  const modId = req.session.mod.id;
  if (!apelacaoId) return res.json({ ok: false, erro: 'Parâmetros inválidos.' });

  try {
    const [[apelacao]] = await db.execute(
      "SELECT * FROM apelacao WHERE id = ? AND status = 'pendente'",
      [apelacaoId],
    );
    if (!apelacao) return res.json({ ok: false, erro: 'Apelação não encontrada.' });

    const respostaLimpa = (resposta || '').slice(0, 500) || null;
    const novoStatus = aceitar ? 'aceita' : 'recusada';

    await db.execute(
      'UPDATE apelacao SET status = ?, mod_id = ?, resposta_mod = ? WHERE id = ?',
      [novoStatus, modId, respostaLimpa, apelacaoId],
    );

    if (aceitar) {
      await db.execute(
        "UPDATE user SET status_conta = 'ativo', suspenso_ate = NULL, motivo_suspensao = NULL WHERE id = ?",
        [apelacao.user_id],
      );
    }

    await criarNotificacao(
      apelacao.user_id,
      'moderacao',
      'Resultado da sua apelação',
      aceitar
        ? 'Sua apelação foi aceita. Sua conta foi reativada.'
        : `Sua apelação foi recusada.${respostaLimpa ? ' ' + respostaLimpa : ''}`,
      { apelacao_id: apelacaoId, aceita: !!aceitar },
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[/mod/api/apelacao/:id/responder]', err.message);
    res.json({ ok: false, erro: 'Erro ao responder apelação.' });
  }
});

module.exports = router;
