'use strict';

// ─── Feedback helper ─────────────────────────────────────────────────────────
function showMsg(el, text, isOk) {
    el.textContent = text;
    el.className   = `cfg-feedback show ${isOk ? 'ok' : 'err'}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.classList.remove('show'); }, 3500);
}

// ─── Loading state on button ──────────────────────────────────────────────────
function setLoading(btn, isLoading, originalText) {
    btn.disabled = isLoading;
    const span   = btn.querySelector('.cfg-btn-text');
    if (span) span.textContent = isLoading ? 'Salvando...' : originalText;
}

// ─── Formulário dados pessoais ────────────────────────────────────────────────
const formDados = document.getElementById('form-dados');
if (formDados) {
    const msgEl = document.getElementById('cfg-dados-msg');
    const btn   = formDados.querySelector('button[type="submit"]');
    const orig  = btn.querySelector('.cfg-btn-text')?.textContent || 'Salvar alterações';

    formDados.addEventListener('submit', async e => {
        e.preventDefault();
        setLoading(btn, true, orig);
        try {
            const res  = await fetch('/config/atualizar-dados', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    nome:               document.getElementById('cfg-nome').value.trim(),
                    email:              document.getElementById('cfg-email').value.trim(),
                    instagram_username: (document.getElementById('cfg-instagram')?.value || '').trim().replace(/^@/, ''),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.erro || 'Erro inesperado.');
            showMsg(msgEl, data.mensagem, true);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (err) {
            showMsg(msgEl, err.message, false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } finally {
            setLoading(btn, false, orig);
        }
    });
}

// ─── Formulário senha ─────────────────────────────────────────────────────────
const formSenha = document.getElementById('form-senha');
if (formSenha) {
    const msgEl = document.getElementById('cfg-senha-msg');
    const btn   = formSenha.querySelector('button[type="submit"]');
    const orig  = btn.querySelector('.cfg-btn-text')?.textContent || 'Alterar senha';

    formSenha.addEventListener('submit', async e => {
        e.preventDefault();
        const novaSenha    = document.getElementById('cfg-nova-senha').value;
        const confirmaSenha = document.getElementById('cfg-confirma-senha').value;
        if (novaSenha !== confirmaSenha) {
            showMsg(msgEl, 'As senhas não coincidem.', false);
            return;
        }
        if (novaSenha.length < 6) {
            showMsg(msgEl, 'A nova senha deve ter pelo menos 6 caracteres.', false);
            return;
        }
        setLoading(btn, true, orig);
        try {
            const res  = await fetch('/config/alterar-senha', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    senhaAtual: document.getElementById('cfg-senha-atual').value,
                    novaSenha,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.erro || 'Erro inesperado.');
            showMsg(msgEl, data.mensagem, true);
            formSenha.reset();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (err) {
            showMsg(msgEl, err.message, false);
        } finally {
            setLoading(btn, false, orig);
        }
    });
}

// ─── Toggle mostrar/ocultar senha ────────────────────────────────────────────
document.querySelectorAll('.cfg-eye').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.querySelector('i').className = isPassword ? 'fas fa-eye-slash' : 'fas fa-eye';
    });
});

// ─── Upload de foto de perfil ─────────────────────────────────────────────────
const avatarRing   = document.getElementById('avatarRing');
const avatarInput  = document.getElementById('cfg-avatar-input');
const avatarPreview = document.getElementById('cfg-avatar-preview');
const avatarBtn    = document.getElementById('cfg-avatar-btn');
const avatarMsg    = document.getElementById('cfg-avatar-msg');
let   pendingFile  = null;
let   currentBlobUrl = null;

if (avatarRing && avatarInput) {
    avatarRing.addEventListener('click', () => avatarInput.click());

    avatarInput.addEventListener('change', () => {
        const file = avatarInput.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            showMsg(avatarMsg, 'Arquivo muito grande. Máximo 5 MB.', false);
            avatarInput.value = '';
            return;
        }
        // Preview ao vivo
        if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = URL.createObjectURL(file);
        avatarPreview.src = currentBlobUrl;
        pendingFile = file;
        avatarBtn.style.display = '';
        showMsg(avatarMsg, 'Pré-visualização carregada. Clique em "Salvar foto" para confirmar.', true);
    });

    avatarBtn.addEventListener('click', async () => {
        if (!pendingFile) return;
        const origText = avatarBtn.querySelector('span')?.textContent || 'Salvar foto';
        avatarBtn.disabled = true;
        if (avatarBtn.querySelector('span')) avatarBtn.querySelector('span').textContent = 'Enviando...';

        try {
            const fd = new FormData();
            fd.append('photo', pendingFile);
            const res  = await fetch('/api/student/profile-photo', { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.erro || 'Erro ao enviar.');

            // Update all avatars on page
            document.querySelectorAll('#sidebar-avatar, #cfg-avatar-preview').forEach(img => {
                img.src = data.photoUrl + '?t=' + Date.now();
            });

            if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
            pendingFile = null;
            avatarBtn.style.display = 'none';
            showMsg(avatarMsg, 'Foto atualizada!', true);
        } catch (err) {
            showMsg(avatarMsg, err.message, false);
        } finally {
            avatarBtn.disabled = false;
            if (avatarBtn.querySelector('span')) avatarBtn.querySelector('span').textContent = origText;
        }
    });
}

// ─── Preferências: Tema ───────────────────────────────────────────────────────
const themeToggle = document.getElementById('pref-theme');
if (themeToggle) {
    const isLight = () => document.body.classList.contains('light-mode');
    const sync    = () => themeToggle.classList.toggle('on', isLight());
    sync();
    themeToggle.addEventListener('click', () => {
        const light = document.body.classList.toggle('light-mode');
        localStorage.setItem('gymbros_theme', light ? 'light' : 'dark');
        sync();
    });
}

// ─── Preferências: Idioma ─────────────────────────────────────────────────────
const langSelect = document.getElementById('pref-lang');
if (langSelect) {
    langSelect.value = localStorage.getItem('gymbros_lang') || 'pt';
    langSelect.addEventListener('change', () => {
        localStorage.setItem('gymbros_lang', langSelect.value);
        // Dispara o sistema de tradução se existir
        if (typeof window.changeLang === 'function') window.changeLang(langSelect.value);
        else location.reload();
    });
}

// ─── Intervalo de lembretes (salvo no servidor) ───────────────────────────────
const btnSalvarNotif = document.getElementById('btnSalvarNotif');
if (btnSalvarNotif) {
    const feedbackEl = document.getElementById('notifFeedback');
    const orig       = btnSalvarNotif.querySelector('.cfg-btn-text')?.textContent || 'Salvar';

    btnSalvarNotif.addEventListener('click', async () => {
        const dias = document.getElementById('notifIntervalo').value;
        setLoading(btnSalvarNotif, true, orig);
        try {
            const res  = await fetch('/config/notificacao-intervalo', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ dias }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.erro || 'Erro inesperado.');
            showMsg(feedbackEl, 'Preferência salva!', true);
        } catch (err) {
            showMsg(feedbackEl, err.message || 'Erro ao salvar.', false);
        } finally {
            setLoading(btnSalvarNotif, false, orig);
        }
    });
}

// ─── Preferências: Notificações ───────────────────────────────────────────────
const notifToggle = document.getElementById('pref-notif');
if (notifToggle) {
    const key   = 'gymbros_notif_enabled';
    const sync  = () => notifToggle.classList.toggle('on', localStorage.getItem(key) !== 'false');
    sync();
    notifToggle.addEventListener('click', () => {
        const cur = localStorage.getItem(key) !== 'false';
        localStorage.setItem(key, cur ? 'false' : 'true');
        sync();
    });
}

// ─── F11 / F13 — Lembretes de água e sono ────────────────────────────────────
(function () {
    const LS_AGUA = 'gymbros_lembrete_agua';
    const LS_SONO = 'gymbros_lembrete_sono';

    function swPostMessage(msg) {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
        navigator.serviceWorker.controller.postMessage(msg);
    }

    async function pedirPermissao() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        const result = await Notification.requestPermission();
        return result === 'granted';
    }

    function loadPrefs() {
        return {
            agua: JSON.parse(localStorage.getItem(LS_AGUA) || '{"ativo":false,"intervaloH":2}'),
            sono: JSON.parse(localStorage.getItem(LS_SONO) || '{"ativo":false,"horario":"22:30"}'),
        };
    }

    function saveAndSync(prefs) {
        localStorage.setItem(LS_AGUA, JSON.stringify(prefs.agua));
        localStorage.setItem(LS_SONO, JSON.stringify(prefs.sono));
        swPostMessage({ type: 'SCHEDULE_AGUA', payload: prefs.agua });
        swPostMessage({ type: 'SCHEDULE_SONO', payload: prefs.sono });
    }

    // ── UI wiring ──────────────────────────────────────────────────────────
    const toggleAgua   = document.getElementById('pref-agua');
    const toggleSono   = document.getElementById('pref-sono');
    const selectAgua   = document.getElementById('agua-intervalo');
    const inputSono    = document.getElementById('sono-horario');
    const subAgua      = document.getElementById('agua-sub');
    const subSono      = document.getElementById('sono-sub');
    const btnSalvar    = document.getElementById('btnSalvarLembretes');
    const feedbackEl   = document.getElementById('lembretesFeedback');

    if (!toggleAgua || !toggleSono) return;

    const prefs = loadPrefs();

    function syncUI() {
        toggleAgua.classList.toggle('on', prefs.agua.ativo);
        toggleSono.classList.toggle('on', prefs.sono.ativo);
        subAgua.classList.toggle('cfg-pref-sub--visible', prefs.agua.ativo);
        subSono.classList.toggle('cfg-pref-sub--visible', prefs.sono.ativo);
        selectAgua.value = String(prefs.agua.intervaloH || 2);
        inputSono.value  = prefs.sono.horario || '22:30';
    }
    syncUI();

    toggleAgua.addEventListener('click', () => {
        prefs.agua.ativo = !prefs.agua.ativo;
        syncUI();
    });

    toggleSono.addEventListener('click', () => {
        prefs.sono.ativo = !prefs.sono.ativo;
        syncUI();
    });

    btnSalvar.addEventListener('click', async () => {
        prefs.agua.intervaloH = parseInt(selectAgua.value, 10) || 2;
        prefs.sono.horario    = inputSono.value || '22:30';

        const temAtivo = prefs.agua.ativo || prefs.sono.ativo;
        if (temAtivo) {
            const ok = await pedirPermissao();
            if (!ok) {
                showMsg(feedbackEl, 'Permissão de notificação negada. Habilite nas configurações do navegador.', false);
                return;
            }
        }

        saveAndSync(prefs);
        showMsg(feedbackEl, 'Lembretes salvos!', true);
    });
})();

// ─── F10 — Toggle Web Push ────────────────────────────────────────────────────
(function () {
    const pushToggle  = document.getElementById('pref-push');
    const feedbackEl  = document.getElementById('pushFeedback');
    if (!pushToggle || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (pushToggle) pushToggle.disabled = true;
        return;
    }

    const LS_KEY = 'gymbros_push_active';

    async function getVapidKey() {
        const res  = await fetch('/push/vapid-public-key');
        const data = await res.json();
        return data.publicKey;
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw     = atob(base64);
        return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }

    async function subscribeUser() {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            showMsg(feedbackEl, 'Permissão negada. Habilite nas configurações do navegador.', false);
            return false;
        }
        const vapidKey = await getVapidKey();
        const reg      = await navigator.serviceWorker.ready;
        const sub      = await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
        const res = await fetch('/push/subscribe', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(sub.toJSON()),
        });
        if (!res.ok) throw new Error('Erro ao salvar subscription.');
        localStorage.setItem(LS_KEY, '1');
        showMsg(feedbackEl, 'Notificações push ativadas!', true);
        return true;
    }

    async function unsubscribeUser() {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await fetch('/push/unsubscribe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ endpoint: sub.endpoint }),
            });
            await sub.unsubscribe();
        }
        localStorage.removeItem(LS_KEY);
        showMsg(feedbackEl, 'Notificações push desativadas.', true);
    }

    // Sincroniza estado visual com a subscription real no browser
    navigator.serviceWorker.ready.then(async reg => {
        const sub    = await reg.pushManager.getSubscription();
        const active = !!sub && Notification.permission === 'granted';
        if (active) localStorage.setItem(LS_KEY, '1');
        else        localStorage.removeItem(LS_KEY);
        pushToggle.classList.toggle('on', active);
    });

    pushToggle.addEventListener('click', async () => {
        const isOn = pushToggle.classList.contains('on');
        pushToggle.disabled = true;
        try {
            if (isOn) {
                await unsubscribeUser();
                pushToggle.classList.remove('on');
            } else {
                const ok = await subscribeUser();
                pushToggle.classList.toggle('on', ok);
            }
        } catch (err) {
            showMsg(feedbackEl, err.message || 'Erro ao alterar notificações.', false);
        } finally {
            pushToggle.disabled = false;
        }
    });
})();
