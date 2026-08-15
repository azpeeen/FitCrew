(function () {
    'use strict';

    var SUPPORTED_PATHS = ['/area-aluno', '/evolucao', '/nutricao', '/treinos', '/conquistas'];

    function currentPath() { return window.location.pathname; }
    function isSupportedPage() { return SUPPORTED_PATHS.indexOf(currentPath()) !== -1; }

    // Uses portrait dimension to avoid false positives after rotation
    function isMobile() { return Math.min(screen.width, screen.height) <= 768; }

    function isLandscape() {
        if (screen.orientation) return screen.orientation.type.startsWith('landscape');
        return window.matchMedia('(orientation: landscape)').matches;
    }

    function getText(selector) {
        var el = document.querySelector(selector);
        return el ? el.textContent.trim() : '—';
    }

    function getTextAt(selector, idx) {
        var els = document.querySelectorAll(selector);
        return els[idx] ? els[idx].textContent.trim() : '—';
    }

    var pageConfigs = {
        '/area-aluno': {
            title: 'Painel',
            icon: 'fa-tachometer-alt',
            metrics: function () {
                return [
                    { label: 'Treinos esta semana', value: getTextAt('.dash-stat-val', 0), icon: 'fa-fire' },
                    { label: 'Conquistas',           value: getTextAt('.dash-stat-val', 1), icon: 'fa-trophy' },
                    { label: 'Meta semanal',         value: getTextAt('.dash-stat-val', 2), icon: 'fa-chart-line' },
                ];
            },
        },
        '/evolucao': {
            title: 'Evolução',
            icon: 'fa-chart-line',
            metrics: function () {
                return [
                    { label: 'Treinos Registrados', value: getText('#stTreinos'), icon: 'fa-dumbbell' },
                    { label: 'Min na Academia',     value: getText('#stTempo'),   icon: 'fa-clock' },
                    { label: 'IMC Atual',            value: getText('#stIMC'),     icon: 'fa-weight' },
                    { label: 'Avaliações',          value: getText('#stAval'),    icon: 'fa-camera' },
                ];
            },
        },
        '/nutricao': {
            title: 'Nutrição',
            icon: 'fa-utensils',
            metrics: function () {
                return [
                    { label: 'kcal restantes', value: getText('#kcalRestantes'),              icon: 'fa-fire' },
                    { label: 'Proteína',       value: getText('#macro-proteina-atual') + 'g', icon: 'fa-dumbbell' },
                    { label: 'Carboidrato',    value: getText('#macro-carbs-atual')    + 'g', icon: 'fa-bolt' },
                    { label: 'Gordura',        value: getText('#macro-gordura-atual')   + 'g', icon: 'fa-droplet' },
                ];
            },
        },
        '/treinos': {
            title: 'Meus Treinos',
            icon: 'fa-dumbbell',
            metrics: function () {
                return [
                    { label: 'Status hoje', value: getText('.checkin-title'),                                      icon: 'fa-calendar-check' },
                    { label: 'Sequência',   value: getText('.checkin-streak-badge') || getText('.checkin-streak-zero'), icon: 'fa-fire' },
                ];
            },
        },
        '/conquistas': {
            title: 'Conquistas',
            icon: 'fa-trophy',
            metrics: function () {
                var sub   = document.querySelector('.conquistas-subtitle');
                var parts = sub ? sub.textContent.trim().split('/') : [];
                var fill  = document.querySelector('.conquistas-progress-fill');
                return [
                    { label: 'Desbloqueadas', value: parts[0] ? parts[0].trim() : '—',                                    icon: 'fa-unlock' },
                    { label: 'Total',         value: parts[1] ? parts[1].replace('conquistadas', '').trim() : '—',        icon: 'fa-trophy' },
                    { label: 'Progresso',     value: fill ? fill.style.width : '—',                                       icon: 'fa-chart-bar' },
                ];
            },
        },
    };

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function buildOverlay() {
        var config = pageConfigs[currentPath()];
        if (!config) return null;

        var metrics = config.metrics().filter(function (m) {
            return m.value && m.value !== '—' && m.value !== 'g' && m.value !== '—g';
        });
        if (!metrics.length) return null;

        var cards = metrics.map(function (m) {
            return '<section class="lr-metric-card">'
                 + '<i class="fas ' + esc(m.icon) + ' lr-metric-icon"></i>'
                 + '<span class="lr-metric-value">' + esc(m.value) + '</span>'
                 + '<span class="lr-metric-label">' + esc(m.label) + '</span>'
                 + '</section>';
        }).join('');

        var overlay = document.createElement('section');
        overlay.id = 'landscape-report-overlay';
        overlay.innerHTML =
            '<section class="lr-header">'
          +   '<section class="lr-title">'
          +     '<i class="fas ' + esc(config.icon) + '"></i>'
          +     '<span>' + esc(config.title) + '</span>'
          +   '</section>'
          +   '<button class="lr-close" id="lr-close-btn" aria-label="Fechar relatório">'
          +     '<i class="fas fa-times"></i>'
          +   '</button>'
          + '</section>'
          + '<section class="lr-grid">' + cards + '</section>';

        return overlay;
    }

    function showOverlay() {
        if (document.getElementById('landscape-report-overlay')) return;
        var overlay = buildOverlay();
        if (!overlay) return;
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        var closeBtn = document.getElementById('lr-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', hideOverlay);
    }

    function hideOverlay() {
        var overlay = document.getElementById('landscape-report-overlay');
        if (overlay) {
            overlay.remove();
            document.body.style.overflow = '';
        }
    }

    var _pending = false;

    function handleOrientationChange() {
        if (_pending) return;
        _pending = true;
        setTimeout(function () {
            _pending = false;
            if (!isMobile() || !isSupportedPage()) return;
            if (isLandscape()) showOverlay();
            else hideOverlay();
        }, 200);
    }

    if (screen.orientation && screen.orientation.addEventListener) {
        screen.orientation.addEventListener('change', handleOrientationChange);
    }

    var mql = window.matchMedia('(orientation: landscape)');
    if (mql.addEventListener) {
        mql.addEventListener('change', handleOrientationChange);
    } else if (mql.addListener) {
        mql.addListener(handleOrientationChange);
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (isMobile() && isSupportedPage() && isLandscape()) {
            setTimeout(showOverlay, 400);
        }
    });

})();
