'use strict';

function abrirModalCompartilhar({ tipo, ref_id, ref_tipo, payload }) {
    return new Promise(resolve => {
        const icones = { checkin: '📍', treino: '💪', conquista: '🏆' };
        const textos = {
            checkin:   'Seus amigos vão ver que você foi treinar!',
            treino:    `Mostre que você concluiu ${payload?.treino_nome || 'um treino'}!`,
            conquista: `Você desbloqueou ${payload?.conquista_icone || '🏆'} ${payload?.conquista_nome || 'uma conquista'}!`,
        };

        const overlay = document.createElement('section');
        overlay.className = 'compartilhar-overlay';
        overlay.innerHTML = `
            <section class="compartilhar-box">
                <section class="compartilhar-icone">${icones[tipo] || '📌'}</section>
                <h3 class="compartilhar-titulo">Compartilhar no feed?</h3>
                <p class="compartilhar-texto">${textos[tipo] || 'Compartilhar com seus amigos?'}</p>
                <section class="compartilhar-botoes">
                    <button type="button" class="compartilhar-btn-nao">Não</button>
                    <button type="button" class="compartilhar-btn-sim">Compartilhar</button>
                </section>
            </section>
        `;
        document.body.appendChild(overlay);

        function fechar(compartilhou) {
            overlay.remove();
            resolve(compartilhou);
        }

        overlay.querySelector('.compartilhar-btn-nao').addEventListener('click', () => fechar(false));
        overlay.querySelector('.compartilhar-btn-sim').addEventListener('click', async () => {
            try {
                await fetch('/api/feed/evento', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tipo, ref_id, ref_tipo, payload }),
                });
            } catch (_) {}
            fechar(true);
        });
        overlay.addEventListener('click', e => { if (e.target === overlay) fechar(false); });
    });
}

window.abrirModalCompartilhar = abrirModalCompartilhar;
