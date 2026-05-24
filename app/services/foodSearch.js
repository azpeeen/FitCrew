'use strict';

const https = require('https');
const { searchTaco } = require('./taco');

// ── Cache em memória (TTL 15 minutos) ────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(key); return null; }
    return e.data;
}
function cacheSet(key, data) {
    if (_cache.size > 300) {
        const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) _cache.delete(oldest[0]);
    }
    _cache.set(key, { data, ts: Date.now() });
}

// ── HTTP com timeout ──────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 4500) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('JSON parse error')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ── Mapa PT → query USDA com operadores ──────────────────────────────────────
const USDA_QUERY_MAP = {
    // Cereais
    'arroz':              'description:(+rice +white +cooked) -cracker -cake -snack',
    'arroz branco':       'description:(+rice +white +cooked) -cracker',
    'arroz integral':     'description:(+rice +brown +cooked) -cracker',
    'macarrao':           'description:(+pasta +cooked) -soup -sauce',
    'macarrão':           'description:(+pasta +cooked) -soup -sauce',
    'espaguete':          'description:(+spaghetti +cooked) -sauce',
    'aveia':              'description:(+oats +rolled) -cookie -bar',
    'granola':            'description:(+granola) -bar',
    'tapioca':            'description:(+tapioca +pearl)',
    'quinoa':             'description:(+quinoa +cooked)',
    'pao':                'description:(+bread +white) -cracker -cake',
    'pão':                'description:(+bread +white) -cracker -cake',
    'pao frances':        'description:(+french +bread) -cracker',
    'pão francês':        'description:(+french +bread) -cracker',
    'pao integral':       'description:(+bread +whole +wheat) -cracker',
    'pão integral':       'description:(+bread +whole +wheat) -cracker',
    // Leguminosas
    'feijao':             'description:(+beans +cooked) -soup -sauce -snack',
    'feijão':             'description:(+beans +cooked) -soup -sauce -snack',
    'feijao preto':       'description:(+black +beans +cooked)',
    'feijão preto':       'description:(+black +beans +cooked)',
    'feijao carioca':     'description:(+pinto +beans +cooked)',
    'feijão carioca':     'description:(+pinto +beans +cooked)',
    'lentilha':           'description:(+lentils +cooked)',
    'grao de bico':       'description:(+chickpeas +cooked)',
    'grão de bico':       'description:(+chickpeas +cooked)',
    'ervilha':            'description:(+peas +green +cooked)',
    'soja':               'description:(+soybeans +cooked)',
    'tofu':               'description:(+tofu +raw)',
    // Carnes bovinas
    'carne':              'description:(+beef +cooked) -soup -stew -broth -snack',
    'carne moida':        'description:(+beef +ground +cooked)',
    'carne moída':        'description:(+beef +ground +cooked)',
    'file mignon':        'description:(+beef +tenderloin +broiled)',
    'filé mignon':        'description:(+beef +tenderloin +broiled)',
    'picanha':            'description:(+beef +sirloin +broiled)',
    'alcatra':            'description:(+beef +round +broiled)',
    'bife':               'description:(+beef +steak +broiled)',
    'hamburguer':         'description:(+beef +hamburger +cooked)',
    'hambúrguer':         'description:(+beef +hamburger +cooked)',
    // Aves
    'frango':             'description:(+chicken +breast +cooked) -nugget -breaded -soup',
    'peito de frango':    'description:(+chicken +breast +skinless +cooked)',
    'coxa de frango':     'description:(+chicken +thigh +cooked)',
    'frango grelhado':    'description:(+chicken +breast +grilled)',
    'frango assado':      'description:(+chicken +roasted)',
    // Peixes
    'atum':               'description:(+tuna +canned +water) -salad',
    'salmao':             'description:(+salmon +cooked) -smoked -canned',
    'salmão':             'description:(+salmon +cooked) -smoked -canned',
    'tilapia':            'description:(+tilapia +cooked)',
    'tilápia':            'description:(+tilapia +cooked)',
    'sardinha':           'description:(+sardine +canned)',
    'camarao':            'description:(+shrimp +cooked)',
    'camarão':            'description:(+shrimp +cooked)',
    'bacalhau':           'description:(+cod +cooked)',
    // Ovos e laticínios
    'ovo':                'description:(+egg +whole +cooked) -salad',
    'ovos':               'description:(+egg +whole +cooked) -salad',
    'ovo cozido':         'description:(+egg +hard +boiled)',
    'clara':              'description:(+egg +white +cooked)',
    'clara de ovo':       'description:(+egg +white +cooked)',
    'leite':              'description:(+milk +whole +fluid) -chocolate -flavored',
    'leite integral':     'description:(+milk +whole +fluid)',
    'leite desnatado':    'description:(+milk +skim +fluid)',
    'iogurte':            'description:(+yogurt +plain +whole) -flavored',
    'iogurte grego':      'description:(+yogurt +greek +plain)',
    'queijo':             'description:(+cheese) -sauce -pizza -dip',
    'queijo minas':       'description:(+cheese +cottage)',
    'queijo mussarela':   'description:(+cheese +mozzarella +whole)',
    'manteiga':           'description:(+butter +salted) -peanut',
    // Tubérculos
    'batata':             'description:(+potato +boiled) -chip -fry -skin',
    'batata cozida':      'description:(+potato +boiled +without +skin)',
    'batata doce':        'description:(+sweet +potato +cooked)',
    'batata frita':       'description:(+french +fries)',
    'batata chips':       'description:(+potato +chips)',
    'mandioca':           'description:(+cassava +cooked)',
    'aipim':              'description:(+cassava +cooked)',
    'inhame':             'description:(+yam +cooked)',
    // Verduras
    'alface':             'description:(+lettuce +raw)',
    'espinafre':          'description:(+spinach +raw)',
    'brocolis':           'description:(+broccoli +cooked)',
    'brócolis':           'description:(+broccoli +cooked)',
    'cenoura':            'description:(+carrots +raw)',
    'tomate':             'description:(+tomato +raw)',
    'cebola':             'description:(+onion +raw)',
    'alho':               'description:(+garlic +raw)',
    'pimentao':           'description:(+pepper +sweet +raw)',
    'pimentão':           'description:(+pepper +sweet +raw)',
    'milho':              'description:(+corn +cooked)',
    'couve':              'description:(+kale +raw)',
    'repolho':            'description:(+cabbage +raw)',
    'abobrinha':          'description:(+zucchini +raw)',
    'vagem':              'description:(+green +beans +cooked)',
    'pepino':             'description:(+cucumber +raw)',
    // Frutas
    'banana':             'description:(+banana +raw)',
    'maca':               'description:(+apple +raw +with +skin)',
    'maçã':               'description:(+apple +raw +with +skin)',
    'laranja':            'description:(+orange +raw)',
    'morango':            'description:(+strawberries +raw)',
    'abacaxi':            'description:(+pineapple +raw)',
    'melancia':           'description:(+watermelon +raw)',
    'manga':              'description:(+mango +raw)',
    'mamao':              'description:(+papaya +raw)',
    'mamão':              'description:(+papaya +raw)',
    'uva':                'description:(+grapes +raw)',
    'abacate':            'description:(+avocado +raw)',
    'kiwi':               'description:(+kiwi +raw)',
    'pera':               'description:(+pear +raw)',
    'pessego':            'description:(+peach +raw)',
    'pêssego':            'description:(+peach +raw)',
    'ameixa':             'description:(+plum +raw)',
    'acai':               'description:(+acai)',
    'açaí':               'description:(+acai)',
    'goiaba':             'description:(+guava +raw)',
    // Oleaginosas
    'amendoim':           'description:(+peanuts +dry +roasted) -butter -oil',
    'pasta de amendoim':  'description:(+peanut +butter)',
    'amendoa':            'description:(+almonds +raw)',
    'amêndoa':            'description:(+almonds +raw)',
    'castanha de caju':   'description:(+cashews +dry +roasted)',
    'castanha do para':   'description:(+brazil +nuts +raw)',
    'castanha do pará':   'description:(+brazil +nuts +raw)',
    'nozes':              'description:(+walnuts +raw)',
    'chia':               'description:(+chia +seeds)',
    'linhaca':            'description:(+flaxseeds +raw)',
    'linhaça':            'description:(+flaxseeds +raw)',
    // Óleos
    'azeite':             'description:(+olive +oil)',
    'oleo de coco':       'description:(+coconut +oil)',
    'óleo de coco':       'description:(+coconut +oil)',
    'oleo de soja':       'description:(+soybean +oil)',
    'óleo de soja':       'description:(+soybean +oil)',
    // Proteínas/suplementos
    'whey':               'description:(+whey +protein)',
    'whey protein':       'description:(+whey +protein)',
    'albumina':           'description:(+egg +white +powder)',
    'caseina':            'description:(+casein +protein)',
    'caseína':            'description:(+casein +protein)',
    // Açúcares
    'acucar':             'description:(+sugar +white)',
    'açúcar':             'description:(+sugar +white)',
    'mel':                'description:(+honey)',
    'doce de leite':      'description:(+dulce +de +leche)',
};

function stripOperators(q) {
    return q
        .replace(/description:\(([^)]*)\)/gi, '$1')
        .replace(/description:/gi, '')
        .replace(/[+()]/g, '')
        .replace(/-\w+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── USDA FoodData Central ─────────────────────────────────────────────────────
async function searchUSDA(queryOriginal, pageSize = 6) {
    const q = queryOriginal.toLowerCase().trim();
    const rawQuery = USDA_QUERY_MAP[q] || queryOriginal;
    const usdaQuery = stripOperators(rawQuery);
    const key = process.env.USDA_API_KEY;

    const cacheKey = `usda:${usdaQuery}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(usdaQuery)}&pageSize=${pageSize}&dataType=Foundation,Survey%20(FNDDS),SR%20Legacy&api_key=${key}`;

    let data;
    try { data = await httpGet(url, 4500); }
    catch (err) { if (err.message !== 'JSON parse error') console.error('[USDA]', err.message); return []; }
    if (!data.foods) return [];

    const temMap = !!USDA_QUERY_MAP[q];
    const seen = new Set();

    const results = data.foods
        .map(f => {
            const getNutrient = (ids) => {
                for (const id of ids) {
                    const n = (f.foodNutrients || []).find(n => n.nutrientId === id);
                    if (n && Number(n.value) > 0) return Number(n.value);
                }
                return 0;
            };
            const nome = temMap ? capitalizar(queryOriginal) : f.description;
            return {
                id:       String(f.fdcId),
                nome,
                nomeEN:   f.description,
                fonte:    'usda',
                dataType: f.dataType || '',
                por100g: {
                    kcal:     getNutrient([2047, 2048, 1008]),
                    proteina: getNutrient([1003]),
                    carbs:    getNutrient([1005]),
                    gordura:  getNutrient([1004]),
                    fibra:    getNutrient([1079]),
                },
            };
        })
        .filter(f => {
            if (!f.por100g.kcal) return false;
            const q2 = queryOriginal.toLowerCase();
            if ((q2.includes('leite') || q2.includes('milk')) && f.por100g.proteina < 2) return false;
            if ((q2.includes('frango') || q2.includes('chicken') || q2.includes('carne') || q2.includes('beef')) && f.por100g.proteina < 8) return false;
            const k = f.nome.toLowerCase().slice(0, 25);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .slice(0, pageSize);

    cacheSet(cacheKey, results);
    return results;
}

// ── Open Food Facts — só para produtos industrializados ───────────────────────
async function searchOFF(query, lang = 'pt', pageSize = 6) {
    const cacheKey = `off:${query}:${lang}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=50&lc=${lang}`;

    let data;
    try { data = await httpGet(url, 4000); }
    catch (err) {
        if (err.message !== 'JSON parse error') console.error('[OFF]', err.message);
        return [];
    }
    if (!data.products) return [];

    const nameField = lang === 'pt' ? 'product_name_pt' : lang === 'es' ? 'product_name_es' : 'product_name_en';
    const qWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
    const seen = new Set();
    const junkTokens = ['biscoito', 'bolacha', 'snack', 'chip', 'barra', 'cereal', 'cookie'];

    const results = data.products
        .filter(p => {
            const nome = (p[nameField] || p.product_name || '').trim();
            if (!nome || !p.nutriments?.['energy-kcal_100g']) return false;
            const nomeLower = nome.toLowerCase();
            if (!qWords.some(w => nomeLower.includes(w))) return false;
            // Penalizar junk se a query não é sobre junk
            if (junkTokens.some(j => nomeLower.includes(j)) && !qWords.some(w => junkTokens.includes(w))) return false;
            const k = nome.slice(0, 30).toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .slice(0, pageSize)
        .map(p => ({
            id:      p.id || p.code,
            nome:    (p[nameField] || p.product_name || '').trim(),
            fonte:   'openfoodfacts',
            nova:    p.nova_group || null,
            por100g: {
                kcal:     Number(p.nutriments['energy-kcal_100g'])  || 0,
                proteina: Number(p.nutriments['proteins_100g'])      || 0,
                carbs:    Number(p.nutriments['carbohydrates_100g']) || 0,
                gordura:  Number(p.nutriments['fat_100g'])           || 0,
                fibra:    Number(p.nutriments['fiber_100g'])         || 0,
            },
        }));

    cacheSet(cacheKey, results);
    return results;
}

// ── Detectar se é alimento staple ou produto industrial ───────────────────────
function isStaple(query) {
    const q = query.toLowerCase();
    const brandTokens = ['zero', 'light', 'diet', 'fit', 'protein', 'sabor', 'flavor', 'bar', 'barra', 'snack', 'integral da', 'marca', 'suplemento'];
    const hasBrand = brandTokens.some(t => q.includes(t)) || q.split(' ').length > 4;
    return !!USDA_QUERY_MAP[q] || !hasBrand;
}

// ── Score de fonte ────────────────────────────────────────────────────────────
function getSourceScore(item) {
    if (item.fonte === 'taco') return 1.0;
    if (item.fonte === 'usda') {
        if (item.dataType === 'Foundation')      return 0.92;
        if (item.dataType === 'Survey (FNDDS)')  return 0.85;
        if (item.dataType === 'SR Legacy')       return 0.78;
        return 0.75;
    }
    if (item.fonte === 'openfoodfacts') {
        if (item.nova === 1 || item.nova === 2) return 0.55;
        if (item.nova === 3)                    return 0.40;
        if (item.nova === 4)                    return 0.20;
        return 0.35;
    }
    return 0.30;
}

// ── Score de completude de macros ─────────────────────────────────────────────
function getCompletenessScore(item) {
    const m = item.por100g;
    let score = 0;
    if (m.kcal > 0)     score += 0.35;
    if (m.proteina > 0) score += 0.30;
    if (m.carbs >= 0)   score += 0.20;
    if (m.gordura >= 0) score += 0.10;
    if (m.fibra > 0)    score += 0.05;
    return score;
}

function capitalizar(s) {
    return String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();
}

// Palavras tipicamente espanholas que indicam produto não-BR
const PALAVRAS_ES = [
    'tortitas','galletas','rellenas','avellana','legumbres',
    'arroz inflado','integral sin','sin gluten','de maíz','tostadas',
    'copos de','bebida de','barrita','barritas','bolitas','palomitas',
    'madalenas','magdalenas','bizcocho','galleta','crema de','leche condensada',
    'con chocolate','con leche','sin lactosa','natillas','flan de',
    ' y ',' con ',' de ',' sin ',' al ',' en ',' del ',' los ',' las ',
];

function filtrarPortugues(results, query) {
    const qWords = query.toLowerCase().split(' ').filter(w => w.length > 2);
    return results.filter(r => {
        const nome = r.nome.toLowerCase();
        if (PALAVRAS_ES.some(p => nome.includes(p))) return false;
        if (!qWords.some(w => nome.includes(w))) return false;
        return true;
    });
}

// ── Busca combinada com ranking próprio ───────────────────────────────────────
async function searchAlimento(query, lang = 'pt') {
    const cacheKey = `combined:${query}:${lang}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const q = query.toLowerCase().trim();
    const temMapa = !!USDA_QUERY_MAP[q];
    const staple  = isStaple(query);

    let tacoResults = [], usdaResults = [], offResults = [];

    tacoResults = searchTaco(query);

    if (temMapa || (staple && tacoResults.length >= 1)) {
        // Staple com mapa ou com resultado TACO → OFF desligado
        const [usda] = await Promise.allSettled([searchUSDA(query, 6)]);
        usdaResults = usda.status === 'fulfilled' ? usda.value : [];
        offResults  = [];
    } else {
        // Produto industrial sem mapa → OFF com filtro de idioma
        const [usda, off] = await Promise.allSettled([
            searchUSDA(query, 4),
            searchOFF(query, lang, 6),
        ]);
        usdaResults = usda.status === 'fulfilled' ? usda.value : [];
        if (off.status === 'fulfilled') {
            offResults = filtrarPortugues(off.value, query);
            // Se o filtro espanhol removeu tudo mas havia produtos, usa filtro mínimo
            if (!offResults.length && off.value.length) {
                const qw = query.toLowerCase().split(' ').filter(w => w.length > 2);
                offResults = off.value
                    .filter(r => qw.some(w => r.nome.toLowerCase().includes(w)))
                    .slice(0, 4);
            }
        }
    }

    const seen = new Set();
    const unique = [...tacoResults, ...usdaResults, ...offResults].filter(r => {
        if (!r.por100g.kcal) return false;
        const k = r.nome.toLowerCase().slice(0, 25);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const results = unique
        .map(r => ({ ...r, _score: getSourceScore(r) * 0.50 + getCompletenessScore(r) * 0.50 }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 10);

    cacheSet(cacheKey, results);
    return results;
}

module.exports = { searchAlimento };
