'use strict';

const WebSocket = require('ws');
const db        = require('../config/db');
const { moderarTexto } = require('./moderacao');

// Map de userId → Set de WebSocket connections (um usuário pode ter várias abas/dispositivos)
const clients = new Map();

// Mídia (foto/áudio) só pode virar mensagem se tiver passado pelo upload
// autenticado (POST /api/chat/mensagens/midia), que já fez a moderação da
// foto. Sem isso, um cliente do WS poderia mandar qualquer URL do Cloudinary
// (inclusive de outra conta) como se fosse uma mídia aprovada. O upload
// registra aqui via registrarMidiaAprovada(); handleMensagem exige o match.
const midiaAprovada = new Map(); // public_id -> { userId, url, ts }
const MIDIA_TTL_MS = 15 * 60 * 1000;

function registrarMidiaAprovada(userId, publicId, url) {
  midiaAprovada.set(publicId, { userId, url, ts: Date.now() });
}

function consumirMidiaAprovada(userId, publicId, url) {
  const entry = midiaAprovada.get(publicId);
  if (!entry) return false;
  const expirada = Date.now() - entry.ts > MIDIA_TTL_MS;
  const valida = !expirada && entry.userId === userId && entry.url === url;
  if (expirada) midiaAprovada.delete(publicId);
  return valida;
}

setInterval(() => {
  const agora = Date.now();
  for (const [publicId, entry] of midiaAprovada) {
    if (agora - entry.ts > MIDIA_TTL_MS) midiaAprovada.delete(publicId);
  }
}, 5 * 60 * 1000).unref();

function iniciarChatWs(server, sessionParser) {
  const wss = new WebSocket.Server({ server, path: '/ws/chat' });

  wss.on('connection', (ws, req) => {
    // Autentica via sessão (mesmo cookie da área do aluno) — nunca confia em
    // dados enviados pelo cliente no handshake.
    sessionParser(req, {}, async () => {
      const user = req.session?.user;
      if (!user) { ws.close(4001, 'Não autenticado'); return; }

      // Conta suspensa/banida não pode usar o chat — o checkContaSuspensa
      // do Express não roda no upgrade do WebSocket, então repetimos aqui.
      if (user.status_conta === 'suspenso' || user.status_conta === 'banido') {
        ws.close(4003, 'Conta bloqueada');
        return;
      }

      const userId = user.id;
      ws._userId = userId;
      ws._userName = user.nome;
      ws._userFoto = user.profile_photo || null;
      ws._userUsername = user.username || null;

      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(ws);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        try {
          switch (msg.type) {
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong' }));
              break;
            case 'mensagem':
              await handleMensagem(ws, user, msg);
              break;
            case 'digitando':
              await handleDigitando(user, msg);
              break;
            case 'lido':
              await handleLido(user, msg);
              break;
          }
        } catch (err) {
          console.error(`[WS] erro processando mensagem de ${userId}:`, err.message);
        }
      });

      ws.on('close', () => {
        const conns = clients.get(userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) clients.delete(userId);
        }
      });

      ws.on('error', (err) => {
        console.error(`[WS] erro user ${userId}:`, err.message);
      });

      try {
        const naoLidas = await contarNaoLidas(userId);
        ws.send(JSON.stringify({ type: 'nao_lidas', total: naoLidas }));
      } catch (_) {}
    });
  });

  return wss;
}

// Envia um payload para todas as conexões abertas de um usuário
function enviarParaUser(userId, data) {
  const conns = clients.get(userId);
  if (!conns) return;
  const json = JSON.stringify(data);
  conns.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

async function handleMensagem(ws, user, msg) {
  const conversaId = parseInt(msg.conversa_id, 10);
  const tipo = msg.tipo;
  let conteudo = msg.conteudo;
  const duracao = tipo === 'audio' && Number.isFinite(msg.duracao) ? Math.round(msg.duracao) : null;

  if (!conversaId || !['texto', 'foto', 'audio'].includes(tipo)) return;

  // user_id sempre da sessão (ws._userId), nunca de dado enviado pelo cliente.
  const [[membro]] = await db.execute(
    'SELECT id FROM chat_membro WHERE conversa_id = ? AND user_id = ?',
    [conversaId, user.id],
  );
  if (!membro) return;

  if (tipo === 'texto') {
    if (!conteudo || !conteudo.trim()) return;
    conteudo = conteudo.trim().slice(0, 4000);
    const mod = await moderarTexto(conteudo, 'chat');
    if (mod.decisao === 'rejeitado') {
      ws.send(JSON.stringify({ type: 'erro', mensagem: 'Mensagem contém conteúdo não permitido.' }));
      return;
    }
  }

  let publicId = null;
  if (tipo === 'foto' || tipo === 'audio') {
    publicId = msg.public_id;
    if (!conteudo || !publicId || !consumirMidiaAprovada(user.id, publicId, conteudo)) {
      ws.send(JSON.stringify({ type: 'erro', mensagem: 'Mídia inválida ou não enviada pelo upload.' }));
      return;
    }
  }

  const [result] = await db.execute(
    `INSERT INTO chat_mensagem (conversa_id, user_id, tipo, conteudo, public_id, duracao, moderado)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [conversaId, user.id, tipo, conteudo, publicId, duracao],
  );
  const msgId = result.insertId;

  await db.execute('UPDATE chat_conversa SET updated_at = NOW() WHERE id = ?', [conversaId]);

  const [membros] = await db.execute(
    'SELECT user_id FROM chat_membro WHERE conversa_id = ?',
    [conversaId],
  );

  const payload = {
    type: 'mensagem',
    id: msgId,
    conversa_id: conversaId,
    user_id: user.id,
    autor_nome: user.nome,
    autor_foto: ws._userFoto,
    autor_username: ws._userUsername,
    tipo,
    conteudo,
    duracao,
    created_at: new Date().toISOString(),
  };

  membros.forEach(({ user_id }) => enviarParaUser(user_id, payload));
}

async function handleDigitando(user, msg) {
  const conversaId = parseInt(msg.conversa_id, 10);
  if (!conversaId) return;

  const [membros] = await db.execute(
    'SELECT user_id FROM chat_membro WHERE conversa_id = ? AND user_id != ?',
    [conversaId, user.id],
  );

  const payload = {
    type: 'digitando',
    conversa_id: conversaId,
    user_id: user.id,
    nome: user.nome,
    digitando: !!msg.digitando,
  };

  membros.forEach(({ user_id }) => enviarParaUser(user_id, payload));
}

async function handleLido(user, msg) {
  const conversaId = parseInt(msg.conversa_id, 10);
  if (!conversaId) return;

  const [result] = await db.execute(
    "UPDATE chat_membro SET ultima_leitura = NOW() WHERE conversa_id = ? AND user_id = ?",
    [conversaId, user.id],
  );
  if (!result.affectedRows) return;

  const [membros] = await db.execute(
    'SELECT user_id FROM chat_membro WHERE conversa_id = ? AND user_id != ?',
    [conversaId, user.id],
  );

  const payload = {
    type: 'lido',
    conversa_id: conversaId,
    user_id: user.id,
    lido_em: new Date().toISOString(),
  };

  membros.forEach(({ user_id }) => enviarParaUser(user_id, payload));
}

async function contarNaoLidas(userId) {
  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total
       FROM chat_mensagem cm
       JOIN chat_membro mb ON mb.conversa_id = cm.conversa_id AND mb.user_id = ?
      WHERE cm.user_id != ?
        AND cm.status = 'ativo'
        AND (mb.ultima_leitura IS NULL OR cm.created_at > mb.ultima_leitura)`,
    [userId, userId],
  );
  return total;
}

module.exports = { iniciarChatWs, enviarParaUser, registrarMidiaAprovada };
