const CACHE_VERSION = 'fitcrew-v1';
const CACHE_STATIC  = `${CACHE_VERSION}-static`;
const CACHE_MEDIA   = `${CACHE_VERSION}-media`;

// ── F11 / F13 — Lembretes de água e sono ─────────────────────────────────────
let _aguaTimer = null;
let _sonoTimer = null;

function agendarAgua(intervaloMs) {
  if (_aguaTimer) { clearTimeout(_aguaTimer); _aguaTimer = null; }
  if (!intervaloMs || intervaloMs <= 0) return;
  function dispara() {
    self.registration.showNotification('💧 Hora de beber água!', {
      body: 'Manter-se hidratado é essencial para seu treino e saúde.',
      icon: '/images/logo.png',
      tag:  'agua-reminder',
    });
    _aguaTimer = setTimeout(dispara, intervaloMs);
  }
  _aguaTimer = setTimeout(dispara, intervaloMs);
}

function agendarSono(horario) {
  if (_sonoTimer) { clearTimeout(_sonoTimer); _sonoTimer = null; }
  if (!horario) return;
  const [hh, mm] = horario.split(':').map(Number);
  function proximoMs() {
    const agora = new Date();
    const alvo  = new Date(agora);
    alvo.setHours(hh, mm, 0, 0);
    if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);
    return alvo - agora;
  }
  function dispara() {
    self.registration.showNotification('😴 Hora de dormir!', {
      body: 'Uma boa noite de sono é fundamental para sua recuperação muscular.',
      icon: '/images/logo.png',
      tag:  'sono-reminder',
    });
    _sonoTimer = setTimeout(dispara, proximoMs());
  }
  _sonoTimer = setTimeout(dispara, proximoMs());
}

self.addEventListener('message', event => {
  const { type, payload } = event.data || {};
  if (type === 'SCHEDULE_AGUA') {
    agendarAgua(payload && payload.ativo ? (payload.intervaloH * 3600000) : 0);
  } else if (type === 'SCHEDULE_SONO') {
    agendarSono(payload && payload.ativo ? payload.horario : null);
  }
});
// ── F10 — Web Push ───────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'FitCrew', body: 'Nova notificação', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/images/logo.png',
      badge: '/images/favicon.ico',
      tag: 'gymbros-push',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.includes(url) && 'focus' in c);
      if (match) return match.focus();
      return clients.openWindow(url);
    })
  );
});
// ─────────────────────────────────────────────────────────────────────────────

// Assets pré-cacheados no install — páginas + estáticos usados na área do
// aluno e na execução de treino, pra ficarem disponíveis offline de cara.
const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/planos',
  '/about',
  '/treinos',
  '/metricas',
  '/conquistas',
  '/manifest.json',
  '/css/header.css',
  '/css/footer.css',
  '/css/style.css',
  '/css/planos.css',
  '/css/pwa.css',
  '/css/area-aluno.css',
  '/css/execucao-treino.css',
  '/css/conquistas.css',
  '/css/compartilhar-feed.css',
  '/css/chat.css',
  '/css/nutricao.css',
  '/css/replay-treino.css',
  '/js/area-aluno.js',
  '/js/header.js',
  '/js/translate.js',
  '/js/conquistas.js',
  '/js/muscle-translate.js',
  '/js/treino-offline.js',
  '/images/logo.png',
  '/images/favicon.ico',
  '/images/avatar.png',
];

// Rotas que nunca devem ser servidas do cache — dados sempre em tempo real
// (feed, chat, IA, notificações/SSE, pagamento, painéis administrativos).
const NO_CACHE_PATTERNS = [
  /\/api\/posts/,
  /\/api\/feed/,
  /\/chat/,
  /\/api\/chat/,
  /\/api\/nutricao\/foto/,
  /\/api\/notificacoes/,
  /\/api\/gymsquads/,
  /\/pagamento/,
  /\/api\/pagamento/,
  /\/admin/,
  /\/mod/,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(async cache => {
      // cache.add() por item (não addAll) — uma página protegida por login
      // (ex.: /treinos sem sessão) responde com redirect, e Cache rejeita
      // isso; um único item assim não pode derrubar o precache inteiro.
      const results = await Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(new Request(url, { credentials: 'same-origin' }))
        )
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn('[SW] falha ao precachear:', STATIC_ASSETS[i], r.reason?.message);
        }
      });
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => (k.startsWith('gymbros-') || k.startsWith('fitcrew-')) && !k.startsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== location.origin && !url.hostname.includes('cloudinary.com')) return;
  if (NO_CACHE_PATTERNS.some(p => p.test(url.pathname + url.search))) return;

  // GIFs de exercício no Cloudinary (pasta gymbros/exercises) — cache 7 dias
  if (url.hostname.includes('cloudinary.com') && url.pathname.includes('exercise')) {
    event.respondWith(cacheFirst(request, CACHE_MEDIA, 7 * 24 * 60 * 60 * 1000));
    return;
  }

  // Assets estáticos — cache first
  if (url.pathname.match(/\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/)) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // Páginas HTML — network first com fallback pro cache e offline.html.
  // Cobre também páginas dinâmicas por querystring (ex.: /treinos/execucao?plano_id=X),
  // que ficam disponíveis offline após a primeira visita online.
  if (request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

// ── Estratégias de cache ────────────────────────────────────────────────

// Cache first: usa cache se disponível (e não expirado), senão network
async function cacheFirst(request, cacheName, maxAge = null) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    if (maxAge) {
      const dateHeader = cached.headers.get('date');
      if (dateHeader) {
        const age = Date.now() - new Date(dateHeader).getTime();
        if (age < maxAge) return cached;
      } else {
        return cached;
      }
    } else {
      return cached;
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    return cached || new Response('Offline', { status: 503 });
  }
}

// Network first com fallback pro cache e página offline
async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match('/offline.html');
  }
}
