'use strict';

/**
 * Mifflin-St Jeor + fatores TDEE simples de mercado.
 * Não somar calorias de exercício por fora — o fator já inclui atividade.
 */
function calcularMetas(imc) {
    if (!imc || !imc.peso || !imc.altura || !imc.idade || !imc.sexo) {
        return {
            kcal: 2000, proteina: 120, carbs: 250,
            gordura: 65, fibra: 25, agua: 2500,
            tmb: 0, tdee: 0, calculado: false
        };
    }

    const peso  = parseFloat(imc.peso);
    const altCm = parseFloat(imc.altura) > 3
        ? parseFloat(imc.altura)
        : parseFloat(imc.altura) * 100;
    const idade = parseInt(imc.idade);
    const sexo  = (imc.sexo || '').toLowerCase();
    const obj   = (imc.objetivo || '').toLowerCase();
    const exp   = (imc.experiencia || '').toLowerCase();

    // Mifflin-St Jeor
    let tmb;
    if (sexo === 'masculino' || sexo === 'm' || sexo === 'male') {
        tmb = 9.99 * peso + 6.25 * altCm - 4.92 * idade + 5;
    } else {
        tmb = 9.99 * peso + 6.25 * altCm - 4.92 * idade - 161;
    }
    tmb = Math.round(tmb);

    // Fatores TDEE de mercado
    const fatores = {
        sedentár: 1.2, sedentario: 1.2, sedent: 1.2,
        leve: 1.375, iniciante: 1.375, baixo: 1.375,
        moderado: 1.55, intermediár: 1.55, intermediario: 1.55, regular: 1.55,
        intenso: 1.725, avançado: 1.725, avancado: 1.725, alto: 1.725,
        atleta: 1.9, elite: 1.9,
    };
    let fator = 1.375;
    for (const [key, val] of Object.entries(fatores)) {
        if (exp.includes(key)) { fator = val; break; }
    }
    const tdee = Math.round(tmb * fator);

    // Ajuste calórico e proteína por objetivo
    let kcalMeta, protFator;
    if (obj.includes('perder') || obj.includes('emagrecer') || obj.includes('cutting') || obj.includes('definir')) {
        kcalMeta  = Math.round(tdee * 0.85);
        protFator = 1.8;
    } else if (obj.includes('ganhar') || obj.includes('massa') || obj.includes('bulking') || obj.includes('hipertrofia')) {
        kcalMeta  = Math.round(tdee * 1.10);
        protFator = 2.0;
    } else {
        kcalMeta  = tdee;
        protFator = 1.6;
    }

    const altM          = altCm / 100;
    const altPolegadas  = altCm / 2.54;
    const pesoIdeal     = (sexo === 'masculino' || sexo === 'm' || sexo === 'male')
        ? 50   + 2.3 * Math.max(0, altPolegadas - 60)
        : 45.5 + 2.3 * Math.max(0, altPolegadas - 60);
    const imcReal         = peso / (altM * altM);
    const pesoParaProtein = imcReal > 25
        ? Math.round(pesoIdeal + 0.25 * (peso - pesoIdeal))
        : peso;

    const proteina  = Math.round(pesoParaProtein * protFator);
    const kcalProt  = proteina * 4;
    const gordura   = Math.round((kcalMeta * 0.25) / 9);
    const kcalGord  = gordura * 9;
    const carbs     = Math.round((kcalMeta - kcalProt - kcalGord) / 4);
    const fibra     = (sexo === 'masculino' || sexo === 'm') ? 38 : 25;
    const agua      = Math.round(peso * 35);

    return {
        kcal: kcalMeta,
        proteina,
        carbs: Math.max(0, carbs),
        gordura,
        fibra,
        agua,
        tmb,
        tdee,
        calculado: true,
    };
}

module.exports = { calcularMetas };
