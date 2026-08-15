// F12 — Treinos sociais: avatares de membros, modal de convite e sair do treino
(function () {
    'use strict';

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Avatares dos membros nos cards de treino do dono ──────────────
    async function carregarAvatares(section) {
        const planId = section.dataset.planId;
        if (!planId) return;
        try {
            const d = await fetch('/api/treinos/' + planId + '/membros').then(r => r.json());
            const aceitos = (d.membros || []).filter(m => m.status === 'aceito');
            if (!aceitos.length) { section.innerHTML = ''; return; }
            const visiveis = aceitos.slice(0, 3);
            const resto = aceitos.length - visiveis.length;
            section.innerHTML =
                visiveis.map(m =>
                    '<img class="treino-membro-avatar" src="' + escHtml(m.foto_perfil || '/images/avatar.png') +
                    '" alt="' + escHtml(m.nome) + '" title="' + escHtml(m.nome) + '">'
                ).join('') +
                (resto > 0 ? '<span class="treino-membros-count">+' + resto + '</span>' : '');
        } catch (_) {}
    }

    document.querySelectorAll('.treino-membros-avatares[data-plan-id]').forEach(carregarAvatares);

    // ── Modal de convite ──────────────────────────────────────────────
    const modal = document.getElementById('modal-convidar-treino');
    const modalTitulo = document.getElementById('modal-convidar-titulo');
    const buscaInput = document.getElementById('convidar-busca-input');
    const amigosLista = document.getElementById('convidar-amigos-lista');
    const fecharBtn = document.getElementById('modal-convidar-fechar');
    let planoAtual = null;
    let amigosCache = [];

    function modoSelecionado() {
        const el = document.querySelector('input[name="modo_colaboracao"]:checked');
        return el ? el.value : 'readonly';
    }

    function renderAmigos(lista) {
        if (!lista.length) {
            amigosLista.innerHTML = '<section class="modal-convidar-vazio">Nenhum amigo encontrado.</section>';
            return;
        }
        amigosLista.innerHTML = lista.map(a => {
            const jaMembro = a.convite_status === 'aceito';
            const pendente = a.convite_status === 'pendente';
            const label = jaMembro ? 'Participa' : pendente ? 'Convidado' : 'Convidar';
            const cls = (jaMembro || pendente) ? 'btn-convidar-amigo enviado' : 'btn-convidar-amigo';
            const disabled = jaMembro ? 'disabled' : '';
            return '' +
                '<section class="modal-convidar-amigo">' +
                    '<img class="modal-convidar-amigo-avatar" src="' + escHtml(a.foto_perfil || '/images/avatar.png') + '" alt="' + escHtml(a.nome) + '">' +
                    '<section class="modal-convidar-amigo-info">' +
                        '<section class="modal-convidar-amigo-nome">' + escHtml(a.nome) + '</section>' +
                        '<section class="modal-convidar-amigo-username">@' + escHtml(a.username || 'usuario') + '</section>' +
                    '</section>' +
                    '<button type="button" class="' + cls + '" data-amigo-id="' + a.id + '" ' + disabled + '>' + label + '</button>' +
                '</section>';
        }).join('');
    }

    async function abrirModal(planId, planNome) {
        planoAtual = planId;
        modalTitulo.textContent = 'Convidar para ' + planNome;
        buscaInput.value = '';
        amigosLista.innerHTML = '<section class="modal-convidar-vazio"><i class="fas fa-spinner fa-spin"></i></section>';
        modal.classList.add('open');
        try {
            const d = await fetch('/api/treinos/' + planId + '/convidaveis').then(r => r.json());
            amigosCache = d.amigos || [];
            const radioModo = document.querySelector('input[name="modo_colaboracao"][value="' + (d.modo || 'readonly') + '"]');
            if (radioModo) radioModo.checked = true;
            renderAmigos(amigosCache);
        } catch (_) {
            amigosLista.innerHTML = '<section class="modal-convidar-vazio">Erro ao carregar amigos.</section>';
        }
    }

    function fecharModal() {
        modal.classList.remove('open');
        planoAtual = null;
    }

    if (modal) {
        document.querySelectorAll('.btn-convidar-treino').forEach(btn => {
            btn.addEventListener('click', () => abrirModal(btn.dataset.planId, btn.dataset.planNome));
        });

        if (fecharBtn) fecharBtn.addEventListener('click', fecharModal);
        modal.addEventListener('click', e => { if (e.target === modal) fecharModal(); });

        if (buscaInput) {
            buscaInput.addEventListener('input', () => {
                const q = buscaInput.value.trim().toLowerCase();
                renderAmigos(amigosCache.filter(a =>
                    (a.nome || '').toLowerCase().includes(q) ||
                    (a.username || '').toLowerCase().includes(q)
                ));
            });
        }

        // Modo de colaboração aplica ao plano (é global do treino)
        document.querySelectorAll('input[name="modo_colaboracao"]').forEach(radio => {
            radio.addEventListener('change', () => {
                if (!planoAtual) return;
                fetch('/api/treinos/' + planoAtual + '/colaboracao', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modo: modoSelecionado() }),
                }).catch(() => {});
            });
        });

        amigosLista.addEventListener('click', async e => {
            const btn = e.target.closest('.btn-convidar-amigo');
            if (!btn || btn.disabled || !planoAtual) return;
            const amigoId = btn.dataset.amigoId;
            btn.disabled = true;
            btn.textContent = '...';
            try {
                const r = await fetch('/api/treinos/' + planoAtual + '/convidar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amigoId: Number(amigoId), modo: modoSelecionado() }),
                }).then(x => x.json());
                if (r.ok) {
                    btn.textContent = 'Convidado';
                    btn.classList.add('enviado');
                    const a = amigosCache.find(x => String(x.id) === String(amigoId));
                    if (a) a.convite_status = 'pendente';
                } else {
                    btn.disabled = false;
                    btn.textContent = 'Convidar';
                }
            } catch (_) {
                btn.disabled = false;
                btn.textContent = 'Convidar';
            }
        });
    }

    // ── Iniciar treino compartilhado ──────────────────────────────────
    document.querySelectorAll('[data-exec-plan]').forEach(btn => {
        btn.addEventListener('click', () => {
            location.href = '/treinos/execucao?plano_id=' + btn.dataset.execPlan;
        });
    });

    // ── Sair de um treino compartilhado ───────────────────────────────
    document.querySelectorAll('.btn-sair-treino').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!window.confirm('Deseja sair deste treino?')) return;
            const planId = btn.dataset.planId;
            btn.disabled = true;
            try {
                const r = await fetch('/api/treinos/' + planId + '/sair', { method: 'POST' }).then(x => x.json());
                if (r.ok) {
                    const card = btn.closest('.treino-compartilhado-card');
                    if (card) card.remove();
                } else {
                    btn.disabled = false;
                }
            } catch (_) {
                btn.disabled = false;
            }
        });
    });
})();
