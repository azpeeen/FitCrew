// ── treino-offline.js ─────────────────────────────────────────────────────
// Fila de ações de sessão de treino (iniciar/concluir/finalizar) via
// IndexedDB, usada quando a rede falha durante a execução de um treino.
// Sincroniza com o servidor quando a conexão volta.

const DB_NAME    = 'gymbros-offline';
const DB_VERSION = 1;
const STORE_NAME = 'sessoes_pendentes';

function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function isSessaoLocal(sessaoId) {
  return typeof sessaoId === 'string' && sessaoId.startsWith('local_');
}

// Enfileira uma ação (iniciar | concluir | finalizar) pendente de sincronização
async function enfileirar(tipo, sessaoId, dados) {
  const db    = await abrirDB();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.add({ tipo, sessaoId, dados, timestamp: Date.now(), sincronizado: false });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
  if (navigator.onLine) sincronizarComServidor();
}

// Cria uma sessão local (offline) e já enfileira o "iniciar" correspondente
async function criarSessaoLocal(workoutPlanId) {
  const sessaoId = 'local_' + Date.now();
  await enfileirar('iniciar', sessaoId, { workout_plan_id: workoutPlanId });
  return sessaoId;
}

async function buscarPendentesOrdenados() {
  const db    = await abrirDB();
  const tx    = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req   = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(
      req.result.filter(r => !r.sincronizado).sort((a, b) => a.timestamp - b.timestamp)
    );
    req.onerror = () => reject(req.error);
  });
}

async function marcarSincronizado(id) {
  const db    = await abrirDB();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const item  = await new Promise((resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
  if (item) {
    item.sincronizado = true;
    store.put(item);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// Reescreve o sessaoId local pelo id real em todas as ações ainda pendentes
// (necessário porque concluir/finalizar dependem do id retornado por iniciar)
async function reatribuirSessaoId(sessaoLocalId, sessaoRealId) {
  const db    = await abrirDB();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const todos = await new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
  todos
    .filter(item => !item.sincronizado && item.sessaoId === sessaoLocalId)
    .forEach(item => {
      item.sessaoId = sessaoRealId;
      store.put(item);
    });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// Sincroniza a fila com o servidor, em ordem, resolvendo sessaoId local → real
async function sincronizarComServidor() {
  if (!navigator.onLine) return;

  const pendentes = await buscarPendentesOrdenados();
  if (!pendentes.length) return;

  console.log(`[offline] sincronizando ${pendentes.length} ação(ões)...`);

  for (const item of pendentes) {
    try {
      if (item.tipo === 'iniciar') {
        const r = await fetch('/treinos/sessao/iniciar', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ workout_plan_id: item.dados.workout_plan_id }),
        });
        const data = await r.json();
        if (!data.sessao_id) continue;
        await reatribuirSessaoId(item.sessaoId, data.sessao_id);
        await marcarSincronizado(item.id);
        continue;
      }

      // concluir/finalizar dependem de um sessaoId já resolvido (não-local)
      if (isSessaoLocal(item.sessaoId)) continue;

      const endpoint = item.tipo === 'concluir'
        ? '/treinos/sessao/exercicio/concluir'
        : '/treinos/sessao/finalizar';
      const body = item.tipo === 'concluir'
        ? { sessao_id: item.sessaoId, ...item.dados }
        : { sessao_id: item.sessaoId };

      const r = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (r.ok) await marcarSincronizado(item.id);
    } catch (err) {
      console.error(`[offline] falha ao sincronizar item ${item.id}:`, err.message);
      break; // rede caiu de novo — retoma na próxima tentativa
    }
  }
}

window.addEventListener('online', () => {
  console.log('[offline] conexão restaurada — sincronizando...');
  sincronizarComServidor();
});

window.treinoOffline = {
  isSessaoLocal,
  criarSessaoLocal,
  enfileirar,
  sincronizarComServidor,
};
