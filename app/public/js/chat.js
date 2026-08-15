(function () {
    'use strict';

    const MEU_ID = window.GYMBROS_USER_ID;
    let conversaAtualId = window.CHAT_CONVERSA_INICIAL || null;
    let conversaAtual = null;
    let conversas = [];
    let amigosCache = [];
    let ws = null;
    let digitandoTimeout = null;
    let ultimoEnvioDigitando = 0;
    let painelInfoAberto = false;

    // ── Helpers ──────────────────────────────────────────────────────────────
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function formatarHora(iso) {
        return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function formatarDataConversa(iso) {
        const d = new Date(iso);
        const hoje = new Date();
        const mesmodia = d.toDateString() === hoje.toDateString();
        if (mesmodia) return formatarHora(iso);
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    function nomeConversa(c) {
        return c.tipo === 'grupo' ? (c.nome || 'Grupo') : (c.outro_nome || 'Usuário');
    }

    function fotoConversa(c) {
        return c.tipo === 'grupo' ? (c.foto || '/images/avatar.png') : (c.outro_foto || '/images/avatar.png');
    }

    // ── Conexão WebSocket compartilhada (aberta em header-aluno.ejs) ──────────
    function ligarSocket(socket) {
        ws = socket;
        ws.addEventListener('message', onSocketMessage);
    }

    if (window.__chatSocket && window.__chatSocket.readyState === WebSocket.OPEN) {
        ligarSocket(window.__chatSocket);
    }
    window.addEventListener('chat:socket-ready', e => ligarSocket(e.detail.socket));

    function wsSend(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    }

    function onSocketMessage(e) {
        let data;
        try { data = JSON.parse(e.data); } catch (_) { return; }

        if (data.type === 'mensagem') {
            atualizarConversaNaLista(data);
            if (data.conversa_id === conversaAtualId) {
                renderizarMensagem(data);
                rolarParaFinal();
                if (data.user_id !== MEU_ID) marcarComoLido(conversaAtualId);
            }
        }

        if (data.type === 'digitando' && data.conversa_id === conversaAtualId && data.user_id !== MEU_ID) {
            const el = document.getElementById('chatDigitando');
            if (el) {
                el.textContent = data.digitando ? `${data.nome} está digitando...` : '';
                el.style.display = data.digitando ? 'block' : 'none';
            }
        }

        if (data.type === 'lido' && data.conversa_id === conversaAtualId && data.user_id !== MEU_ID) {
            marcarBolhasComoLidas(data.lido_em);
            atualizarStatusVisto(data.lido_em);
        }

        if (data.type === 'erro') {
            alert(data.mensagem || 'Erro no chat.');
        }
    }

    // ── Lista de conversas ──────────────────────────────────────────────────
    async function carregarConversas() {
        const lista = document.getElementById('listaConversas');
        try {
            const d = await fetch('/api/chat/conversas').then(r => r.json());
            conversas = d.conversas || [];
            renderizarListaConversas();
            if (conversaAtualId) abrirConversa(conversaAtualId, false);
        } catch (_) {
            lista.innerHTML = '<section class="chat-lista-vazia">Erro ao carregar conversas.</section>';
        }
    }

    function renderizarListaConversas(filtro) {
        const lista = document.getElementById('listaConversas');
        const termo = (filtro || '').toLowerCase().trim();
        const filtradas = termo
            ? conversas.filter(c => nomeConversa(c).toLowerCase().includes(termo))
            : conversas;

        if (!filtradas.length) {
            lista.innerHTML = termo
                ? `<section class="chat-lista-vazia"><i class="fas fa-search"></i><p>Nenhuma conversa encontrada</p><small>Tente buscar por outro nome</small></section>`
                : `<section class="chat-lista-vazia"><i class="fas fa-comments"></i><p>Nenhuma conversa ainda</p><small>Pesquise um amigo para começar</small></section>`;
            return;
        }

        lista.innerHTML = filtradas.map(c => {
            const preview = !c.ultima_msg_at ? 'Nenhuma mensagem ainda'
                : c.ultima_msg_tipo === 'foto' ? '📷 Foto'
                : c.ultima_msg_tipo === 'audio' ? '🎤 Áudio'
                : escHtml((c.ultima_msg || '').slice(0, 40));
            return `
                <section class="chat-conversa-item ${c.id === conversaAtualId ? 'ativa' : ''}" data-id="${c.id}">
                    <img class="chat-conversa-avatar" src="${escHtml(fotoConversa(c))}" alt="">
                    <section class="chat-conversa-info">
                        <section class="chat-conversa-linha1">
                            <span class="chat-conversa-nome">${escHtml(nomeConversa(c))}</span>
                            ${c.ultima_msg_at ? `<span class="chat-conversa-hora">${formatarDataConversa(c.ultima_msg_at)}</span>` : ''}
                        </section>
                        <section class="chat-conversa-linha2">
                            <span class="chat-conversa-preview">${preview}</span>
                            ${c.nao_lidas > 0 ? `<span class="chat-conversa-badge">${c.nao_lidas > 99 ? '99+' : c.nao_lidas}</span>` : ''}
                        </section>
                    </section>
                </section>`;
        }).join('');
    }

    function atualizarConversaNaLista(msg) {
        let c = conversas.find(x => x.id === msg.conversa_id);
        if (!c) { carregarConversas(); return; }
        c.ultima_msg = msg.conteudo;
        c.ultima_msg_tipo = msg.tipo;
        c.ultima_msg_at = msg.created_at;
        c.ultima_msg_user_id = msg.user_id;
        c.updated_at = msg.created_at;
        if (msg.user_id !== MEU_ID && msg.conversa_id !== conversaAtualId) {
            c.nao_lidas = (c.nao_lidas || 0) + 1;
        }
        conversas.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
        renderizarListaConversas(document.getElementById('chatBusca').value);
    }

    document.getElementById('chatBusca').addEventListener('input', e => renderizarListaConversas(e.target.value));

    document.getElementById('listaConversas').addEventListener('click', e => {
        const item = e.target.closest('.chat-conversa-item');
        if (!item) return;
        abrirConversa(parseInt(item.dataset.id, 10));
    });

    // ── Abrir conversa ────────────────────────────────────────────────────────
    async function abrirConversa(id, atualizarUrl) {
        conversaAtualId = id;
        if (atualizarUrl !== false) history.replaceState(null, '', `/chat/${id}`);

        document.getElementById('chatVazio').style.display = 'none';
        document.getElementById('chatAtivo').style.display = 'flex';
        document.getElementById('chatApp').classList.add('mostrando-chat');
        document.querySelectorAll('.chat-conversa-item').forEach(el => {
            el.classList.toggle('ativa', parseInt(el.dataset.id, 10) === id);
        });

        const c = conversas.find(x => x.id === id);
        conversaAtual = c || null;
        fecharInfoPanel();
        if (c) {
            document.getElementById('chatCabecalhoAvatar').src = fotoConversa(c);
            document.getElementById('chatCabecalhoNome').textContent = nomeConversa(c);
            document.getElementById('chatCabecalhoStatus').textContent = c.tipo === 'grupo' ? 'Grupo' : '';
            c.nao_lidas = 0;
            renderizarListaConversas(document.getElementById('chatBusca').value);
        }

        const mensagensEl = document.getElementById('chatMensagens');
        mensagensEl.innerHTML = '<section class="chat-loading"><i class="fas fa-spinner fa-spin"></i></section>';
        try {
            const d = await fetch(`/api/chat/conversas/${id}/mensagens`).then(r => r.json());
            mensagensEl.innerHTML = '';
            if (!d.mensagens?.length) {
                mensagensEl.innerHTML = '<section class="chat-mensagens-vazio">Nenhuma mensagem ainda. Diga oi!</section>';
            } else {
                d.mensagens.forEach(renderizarMensagem);
                rolarParaFinal();
            }
            if (d.lido_ate) {
                marcarBolhasComoLidas(d.lido_ate);
                atualizarStatusVisto(d.lido_ate);
            }
        } catch (_) {
            mensagensEl.innerHTML = '<section class="chat-mensagens-vazio">Erro ao carregar mensagens.</section>';
        }

        marcarComoLido(id);
    }

    function marcarComoLido(conversaId) {
        wsSend({ type: 'lido', conversa_id: conversaId });
    }

    document.getElementById('chatVoltar').addEventListener('click', () => {
        document.getElementById('chatApp').classList.remove('mostrando-chat');
        conversaAtualId = null;
        conversaAtual = null;
        fecharInfoPanel();
        history.replaceState(null, '', '/chat');
    });

    document.getElementById('chatVoltarHome').addEventListener('click', () => {
        history.back();
    });

    // ── Painel de informações da conversa ───────────────────────────────────
    document.getElementById('chatCabecalhoClicavel').addEventListener('click', toggleInfoPanel);
    document.getElementById('chatBtnInfo').addEventListener('click', toggleInfoPanel);
    document.getElementById('chatInfoFechar').addEventListener('click', fecharInfoPanel);

    function toggleInfoPanel() {
        painelInfoAberto ? fecharInfoPanel() : abrirInfoPanel();
    }

    function abrirInfoPanel() {
        if (!conversaAtual) return;
        painelInfoAberto = true;
        document.getElementById('chatInfoPanel').classList.add('aberto');

        document.getElementById('chatInfoFoto').src = fotoConversa(conversaAtual);
        document.getElementById('chatInfoNome').textContent = nomeConversa(conversaAtual);

        const ehGrupo = conversaAtual.tipo === 'grupo';
        document.getElementById('chatInfoUsername').textContent = ehGrupo ? '' : `@${conversaAtual.outro_username || 'usuario'}`;

        const verPerfil = document.getElementById('chatInfoVerPerfil');
        verPerfil.style.display = ehGrupo ? 'none' : 'inline-block';
        if (!ehGrupo) verPerfil.href = `/u/${conversaAtual.outro_username || ''}`;

        document.getElementById('chatInfoAcoes').style.display = ehGrupo ? 'none' : 'flex';

        document.getElementById('chatInfoBusca').value = '';
        document.getElementById('chatInfoBuscaResultados').innerHTML = '';

        carregarMidiasConversa(conversaAtual.id);
    }

    function fecharInfoPanel() {
        painelInfoAberto = false;
        const el = document.getElementById('chatInfoPanel');
        if (el) el.classList.remove('aberto');
    }

    async function carregarMidiasConversa(conversaId) {
        const el = document.getElementById('chatInfoMidias');
        el.innerHTML = '<section class="chat-info-loading"><i class="fas fa-spinner fa-spin"></i></section>';
        try {
            const r = await fetch(`/api/chat/conversas/${conversaId}/midias`).then(x => x.json());
            if (!r.midias?.length) {
                el.innerHTML = '<section class="chat-info-loading">Nenhuma mídia ainda</section>';
                return;
            }
            el.innerHTML = r.midias.map(m => `
                <section class="chat-info-midia-item">
                    <img src="${escHtml(m.conteudo)}" alt="Mídia" loading="lazy">
                </section>
            `).join('');
        } catch (_) {
            el.innerHTML = '<section class="chat-info-loading">Erro ao carregar</section>';
        }
    }

    let buscaMsgTimer;
    document.getElementById('chatInfoBusca').addEventListener('input', e => {
        clearTimeout(buscaMsgTimer);
        const q = e.target.value.trim();
        const resultados = document.getElementById('chatInfoBuscaResultados');
        if (!q || !conversaAtual) { resultados.innerHTML = ''; return; }

        buscaMsgTimer = setTimeout(async () => {
            try {
                const r = await fetch(`/api/chat/conversas/${conversaAtual.id}/buscar?q=${encodeURIComponent(q)}`).then(x => x.json());
                if (!r.mensagens?.length) {
                    resultados.innerHTML = '<section class="chat-info-busca-resultado">Nenhum resultado</section>';
                    return;
                }
                const termoRegex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                resultados.innerHTML = r.mensagens.map(m => {
                    const destacado = escHtml(m.conteudo || '').replace(termoRegex, '<strong>$1</strong>');
                    return `<section class="chat-info-busca-resultado">${destacado}</section>`;
                }).join('');
            } catch (_) {}
        }, 300);
    });

    document.getElementById('chatBtnDenunciar').addEventListener('click', async () => {
        if (!conversaAtual || conversaAtual.tipo === 'grupo') return;
        if (!confirm('Denunciar este usuário?')) return;
        try {
            const r = await fetch(`/api/usuarios/${conversaAtual.outro_id}/denunciar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ motivo: 'outro' }),
            }).then(x => x.json());
            alert(r.ok ? 'Denúncia enviada.' : (r.erro || 'Erro ao denunciar.'));
        } catch (_) {
            alert('Erro ao denunciar.');
        }
        fecharInfoPanel();
    });

    document.getElementById('chatBtnBloquear').addEventListener('click', async () => {
        if (!conversaAtual || conversaAtual.tipo === 'grupo') return;
        if (!confirm('Bloquear este usuário? Vocês não poderão mais se enviar mensagens.')) return;
        try {
            await fetch(`/api/amizades/${conversaAtual.outro_id}/bloquear`, { method: 'POST' });
        } catch (_) {}
        fecharInfoPanel();
        window.location.href = '/chat';
    });

    // ── Renderizar mensagens ─────────────────────────────────────────────────
    function renderizarMensagem(msg) {
        const mensagensEl = document.getElementById('chatMensagens');
        const vazio = mensagensEl.querySelector('.chat-mensagens-vazio');
        if (vazio) vazio.remove();

        const minha = msg.user_id === MEU_ID;
        const linha = document.createElement('section');
        linha.className = `chat-bolha-linha ${minha ? 'chat-bolha-linha--minha' : ''}`;
        linha.dataset.msgId = msg.id;
        linha.dataset.createdAt = msg.created_at;

        let conteudoHtml;
        if (msg.tipo === 'foto') {
            conteudoHtml = `<section class="chat-bolha-foto"><img src="${escHtml(msg.conteudo)}" alt="Foto" data-full="${escHtml(msg.conteudo)}"></section>`;
        } else if (msg.tipo === 'audio') {
            conteudoHtml = `<section class="chat-bolha-audio"><audio controls src="${escHtml(msg.conteudo)}"></audio></section>`;
        } else {
            conteudoHtml = `<section>${escHtml(msg.conteudo)}</section>`;
        }

        linha.innerHTML = `
            <section class="chat-bolha chat-bolha--${minha ? 'minha' : 'dele'}">
                <section class="chat-bolha-autor">${escHtml(msg.autor_nome)}</section>
                ${conteudoHtml}
                <section class="chat-bolha-hora">${formatarHora(msg.created_at)}${minha ? ' <span class="chat-bolha-check">✓</span>' : ''}</section>
            </section>`;

        mensagensEl.appendChild(linha);
    }

    function marcarBolhasComoLidas(lidoEm) {
        const limite = new Date(lidoEm).getTime();
        document.querySelectorAll('.chat-bolha-linha--minha').forEach(linha => {
            if (new Date(linha.dataset.createdAt).getTime() <= limite) {
                const check = linha.querySelector('.chat-bolha-check');
                if (check) {
                    check.textContent = '✓✓';
                    check.classList.add('lido');
                }
            }
        });
    }

    // Mostra "Visto ..." abaixo da última mensagem minha que já foi lida.
    function atualizarStatusVisto(lidoEm) {
        document.querySelectorAll('.chat-visto-label').forEach(el => el.remove());
        if (!lidoEm) return;

        const minhas = document.querySelectorAll('.chat-bolha-linha--minha');
        const ultima = minhas[minhas.length - 1];
        if (!ultima) return;
        if (new Date(ultima.dataset.createdAt).getTime() > new Date(lidoEm).getTime()) return;

        const label = document.createElement('section');
        label.className = 'chat-visto-label';
        label.textContent = `Visto ${formatarVisto(lidoEm)}`;
        ultima.insertAdjacentElement('afterend', label);
    }

    function formatarVisto(iso) {
        const d = new Date(iso);
        const agora = new Date();
        const diffMin = Math.round((agora - d) / 60000);
        if (diffMin < 1) return 'agora há pouco';
        if (diffMin < 60) return `há ${diffMin} min`;
        const diffH = Math.round(diffMin / 60);
        if (diffH < 24) return `há ${diffH}h`;
        return d.toLocaleDateString('pt-BR');
    }

    function rolarParaFinal() {
        const el = document.getElementById('chatMensagens');
        el.scrollTop = el.scrollHeight;
    }

    // Visualizador de foto em tela cheia
    document.getElementById('chatMensagens').addEventListener('click', e => {
        const img = e.target.closest('.chat-bolha-foto img');
        if (!img) return;
        document.getElementById('chatFotoFullscreenImg').src = img.dataset.full;
        document.getElementById('chatFotoFullscreen').classList.add('open');
    });
    document.getElementById('fecharFotoFullscreen').addEventListener('click', () => {
        document.getElementById('chatFotoFullscreen').classList.remove('open');
    });
    document.getElementById('chatFotoFullscreen').addEventListener('click', e => {
        if (e.target.id === 'chatFotoFullscreen') document.getElementById('chatFotoFullscreen').classList.remove('open');
    });

    // ── Enviar texto ─────────────────────────────────────────────────────────
    const inputTexto = document.getElementById('chatInputTexto');

    function enviarTexto() {
        const texto = inputTexto.value.trim();
        if (!texto || !conversaAtualId) return;
        wsSend({ type: 'mensagem', conversa_id: conversaAtualId, tipo: 'texto', conteudo: texto });
        inputTexto.value = '';
        enviarDigitando(false);
    }

    document.getElementById('btnEnviar').addEventListener('click', enviarTexto);
    inputTexto.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); enviarTexto(); }
    });

    function enviarDigitando(digitando) {
        if (!conversaAtualId) return;
        wsSend({ type: 'digitando', conversa_id: conversaAtualId, digitando });
    }

    inputTexto.addEventListener('input', () => {
        const agora = Date.now();
        if (agora - ultimoEnvioDigitando > 2000) {
            enviarDigitando(true);
            ultimoEnvioDigitando = agora;
        }
        clearTimeout(digitandoTimeout);
        digitandoTimeout = setTimeout(() => enviarDigitando(false), 3000);
    });

    // ── Enviar foto ──────────────────────────────────────────────────────────
    const fotoInput = document.getElementById('chatFotoInput');
    document.getElementById('btnAnexo').addEventListener('click', () => fotoInput.click());
    fotoInput.addEventListener('change', async () => {
        const arquivo = fotoInput.files[0];
        fotoInput.value = '';
        if (!arquivo || !conversaAtualId) return;
        await enviarMidia(arquivo, 'foto');
    });

    async function enviarMidia(arquivo, tipoEsperado, duracao) {
        const btnEnviar = document.getElementById('btnEnviar');
        btnEnviar.disabled = true;
        try {
            const form = new FormData();
            form.append('midia', arquivo, arquivo.name || (tipoEsperado === 'audio' ? 'audio.webm' : 'foto.jpg'));
            const r = await fetch('/api/chat/mensagens/midia', { method: 'POST', body: form }).then(x => x.json());
            if (!r.ok) { alert(r.erro || 'Erro no upload.'); return; }
            wsSend({
                type: 'mensagem',
                conversa_id: conversaAtualId,
                tipo: r.tipo,
                conteudo: r.url,
                public_id: r.public_id,
                duracao: duracao || undefined,
            });
        } catch (_) {
            alert('Erro ao enviar mídia.');
        } finally {
            btnEnviar.disabled = false;
        }
    }

    // ── Gravação de áudio ────────────────────────────────────────────────────
    let mediaRecorder = null;
    let audioChunks = [];
    let gravandoDesde = 0;
    let gravandoInterval = null;

    async function iniciarGravacao() {
        if (!conversaAtualId) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); };
            mediaRecorder.start();

            gravandoDesde = Date.now();
            document.getElementById('chatInputRow').style.display = 'none';
            document.getElementById('chatGravando').style.display = 'flex';
            atualizarTempoGravacao();
            gravandoInterval = setInterval(atualizarTempoGravacao, 500);
        } catch (_) {
            alert('Não foi possível acessar o microfone.');
        }
    }

    function atualizarTempoGravacao() {
        const seg = Math.floor((Date.now() - gravandoDesde) / 1000);
        const m = String(Math.floor(seg / 60)).padStart(1, '0');
        const s = String(seg % 60).padStart(2, '0');
        document.getElementById('chatGravandoTempo').textContent = `${m}:${s}`;
    }

    function pararUiGravacao() {
        clearInterval(gravandoInterval);
        document.getElementById('chatGravando').style.display = 'none';
        document.getElementById('chatInputRow').style.display = 'flex';
    }

    document.getElementById('btnAudio').addEventListener('click', iniciarGravacao);

    document.getElementById('btnCancelarGravacao').addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        pararUiGravacao();
    });

    document.getElementById('btnEnviarGravacao').addEventListener('click', () => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') { pararUiGravacao(); return; }
        const duracaoSegundos = Math.round((Date.now() - gravandoDesde) / 1000);
        mediaRecorder.onstop = async () => {
            mediaRecorder.stream?.getTracks?.().forEach(t => t.stop());
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            await enviarMidia(blob, 'audio', duracaoSegundos);
        };
        mediaRecorder.stop();
        pararUiGravacao();
    });

    // ── Modal: nova conversa / criar grupo ──────────────────────────────────
    const modal = document.getElementById('modalNovaConversa');

    document.getElementById('btnNovaConversa').addEventListener('click', async () => {
        modal.classList.add('open');
        if (!amigosCache.length) {
            try {
                const d = await fetch('/api/amizades/lista').then(r => r.json());
                amigosCache = d.amigos || [];
            } catch (_) { amigosCache = []; }
        }
        renderizarAmigos('individual');
        renderizarAmigos('grupo');
    });

    document.getElementById('fecharModalNovaConversa').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });

    document.querySelectorAll('.chat-modal-aba').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chat-modal-aba').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.chat-modal-conteudo').forEach(c => {
                c.style.display = c.dataset.conteudo === btn.dataset.aba ? 'block' : 'none';
            });
        });
    });

    function renderizarAmigos(aba, filtro) {
        const container = document.getElementById(aba === 'grupo' ? 'listaAmigosGrupo' : 'listaAmigosIndividual');
        const termo = (filtro || '').toLowerCase().trim();
        const lista = termo ? amigosCache.filter(a => a.nome.toLowerCase().includes(termo)) : amigosCache;

        if (!lista.length) {
            container.innerHTML = '<section class="modal-convidar-vazio">Nenhum amigo encontrado.</section>';
            return;
        }

        container.innerHTML = lista.map(a => aba === 'grupo' ? `
            <label class="modal-convidar-amigo chat-amigo-check">
                <input type="checkbox" value="${a.id}" class="chat-grupo-membro-check">
                <img class="modal-convidar-amigo-avatar" src="${escHtml(a.foto_perfil || '/images/avatar.png')}" alt="">
                <section class="modal-convidar-amigo-info">
                    <section class="modal-convidar-amigo-nome">${escHtml(a.nome)}</section>
                    <section class="modal-convidar-amigo-username">@${escHtml(a.username || 'usuario')}</section>
                </section>
            </label>
        ` : `
            <section class="modal-convidar-amigo" data-user-id="${a.id}">
                <img class="modal-convidar-amigo-avatar" src="${escHtml(a.foto_perfil || '/images/avatar.png')}" alt="">
                <section class="modal-convidar-amigo-info">
                    <section class="modal-convidar-amigo-nome">${escHtml(a.nome)}</section>
                    <section class="modal-convidar-amigo-username">@${escHtml(a.username || 'usuario')}</section>
                </section>
                <button type="button" class="btn-convidar-amigo" data-abrir-conversa="${a.id}">Conversar</button>
            </section>
        `).join('');
    }

    document.getElementById('buscaAmigoIndividual').addEventListener('input', e => renderizarAmigos('individual', e.target.value));
    document.getElementById('buscaAmigoGrupo').addEventListener('input', e => renderizarAmigos('grupo', e.target.value));

    document.getElementById('listaAmigosIndividual').addEventListener('click', async e => {
        const btn = e.target.closest('[data-abrir-conversa]');
        if (!btn) return;
        btn.disabled = true;
        try {
            const r = await fetch('/api/chat/conversas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: parseInt(btn.dataset.abrirConversa, 10) }),
            }).then(x => x.json());
            if (r.ok) {
                modal.classList.remove('open');
                await carregarConversas();
                abrirConversa(r.conversaId);
            } else {
                alert(r.erro || 'Erro ao criar conversa.');
                btn.disabled = false;
            }
        } catch (_) { btn.disabled = false; }
    });

    document.getElementById('btnCriarGrupo').addEventListener('click', async () => {
        const nome = document.getElementById('nomeGrupo').value.trim();
        const membros = Array.from(document.querySelectorAll('.chat-grupo-membro-check:checked')).map(el => parseInt(el.value, 10));
        if (!nome) { alert('Digite um nome para o grupo.'); return; }
        if (!membros.length) { alert('Selecione pelo menos um amigo.'); return; }

        const btn = document.getElementById('btnCriarGrupo');
        btn.disabled = true;
        try {
            const r = await fetch('/api/chat/grupos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, membros }),
            }).then(x => x.json());
            if (r.ok) {
                modal.classList.remove('open');
                document.getElementById('nomeGrupo').value = '';
                document.querySelectorAll('.chat-grupo-membro-check:checked').forEach(el => el.checked = false);
                await carregarConversas();
                abrirConversa(r.conversaId);
            } else {
                alert(r.erro || 'Erro ao criar grupo.');
            }
        } catch (_) {
            alert('Erro ao criar grupo.');
        } finally {
            btn.disabled = false;
        }
    });

    // ── Init ─────────────────────────────────────────────────────────────────
    carregarConversas();
})();
