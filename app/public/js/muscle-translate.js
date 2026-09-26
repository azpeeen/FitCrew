'use strict';

// Tradução de body_part/target_muscle (tabela `exercises`, em inglês) pra PT-BR.
// Compartilhado entre execução de treino e replay de treino.
const MUSCLE_PT = {
    lats: 'Latíssimo do Dorso', pectorals: 'Peitoral', biceps: 'Bíceps',
    triceps: 'Tríceps', quads: 'Quadríceps', hamstrings: 'Isquiotibiais',
    glutes: 'Glúteos', delts: 'Deltóide', abs: 'Abdômen', calves: 'Panturrilha',
    back: 'Costas', chest: 'Peito', shoulders: 'Ombros',
    'upper arms': 'Braços', 'upper legs': 'Pernas', waist: 'Abdômen',
    forearms: 'Antebraços', traps: 'Trapézio', spine: 'Coluna',
    'lower back': 'Lombar', neck: 'Pescoço', cardiovascular: 'Cardiovascular',
    'upper back': 'Costas Superior', 'cardiovascular system': 'Cardio',
    abductors: 'Abdutores', 'lower arms': 'Antebraços', 'lower legs': 'Panturrilha',
};

function translateMuscle(s) {
    if (!s) return s;
    const k = s.toLowerCase().trim();
    return MUSCLE_PT[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

window.MUSCLE_PT = MUSCLE_PT;
window.translateMuscle = translateMuscle;
