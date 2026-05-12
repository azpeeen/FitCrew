const CACHE_NAME = 'gymbros-v3';

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
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_ASSETS = [
  '/offline.html',
  '/',
  '/login',
  '/planos',
  '/about',
  '/css/header.css',
  '/css/footer.css',
  '/css/area-aluno.css',
  '/css/style.css',
  '/css/planos.css',
  '/css/pwa.css',
  '/js/area-aluno.js',
  '/js/header.js',
  '/js/translate.js',
  '/images/logo.png',
  '/images/favicon.ico',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/') || event.request.url.includes('/ai/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/offline.html');
          }
        })
      )
  );
});
