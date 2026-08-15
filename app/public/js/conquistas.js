'use strict';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _conquistaFila = [];
let _conquistaRodando = false;

async function mostrarAnimacaoConquista(conquista) {
    return new Promise(resolve => {
        _conquistaFila.push({ conquista, resolve });
        if (!_conquistaRodando) _processarFila();
    });
}

async function _processarFila() {
    if (_conquistaFila.length === 0) { _conquistaRodando = false; return; }
    _conquistaRodando = true;
    const { conquista, resolve } = _conquistaFila.shift();
    await _exibirConquista(conquista);
    await sleep(300);
    resolve();
    _processarFila();
}

async function _exibirConquista(conquista) {
    return new Promise(resolve => {
        const overlay = document.createElement('section');
        overlay.className = 'conquista-overlay';

        const cores = {
            bronze:   { primary: '#CD7F32', glow: 'rgba(205,127,50,0.4)',  particles: '#E8A050' },
            prata:    { primary: '#C0C0C0', glow: 'rgba(192,192,192,0.4)', particles: '#E8E8E8' },
            ouro:     { primary: '#FFD700', glow: 'rgba(255,215,0,0.4)',   particles: '#FFF176' },
            platina:  { primary: '#E5E4E2', glow: 'rgba(229,228,226,0.4)', particles: '#FFFFFF' },
            diamante: { primary: '#89CFF0', glow: 'rgba(137,207,240,0.5)', particles: '#B9F2FF' },
        };

        const cor = cores[conquista.tier] || cores.bronze;

        overlay.innerHTML = `
          <section class="conquista-animation-box">
            <button class="conquista-fechar" onclick="this.closest('.conquista-overlay').click()">✕</button>
            <section class="conquista-particles" id="conquistaParticles"></section>
            <section class="conquista-badge-anim" style="--tier-color:${cor.primary};--tier-glow:${cor.glow}">
              <section class="conquista-badge-ring"></section>
              <section class="conquista-badge-icon">${conquista.icone}</section>
            </section>
            <section class="conquista-tier-label" style="color:${cor.primary}">${conquista.tier.toUpperCase()}</section>
            <section class="conquista-nome-anim">${conquista.nome}</section>
            <section class="conquista-sub-anim">Conquista desbloqueada!</section>
          </section>
        `;

        document.body.appendChild(overlay);

        const particlesContainer = overlay.querySelector('#conquistaParticles');
        for (let i = 0; i < 20; i++) {
            const p = document.createElement('section');
            p.className = 'particle';
            p.style.cssText = `--angle:${Math.random() * 360}deg;--distance:${60 + Math.random() * 80}px;--delay:${Math.random() * 0.5}s;background:${cor.particles};`;
            particlesContainer.appendChild(p);
        }

        function fechar() {
            overlay.classList.add('conquista-overlay--out');
            setTimeout(() => { overlay.remove(); resolve(); }, 400);
        }

        setTimeout(fechar, 2500);
        overlay.addEventListener('click', fechar, { once: true });
    });
}
