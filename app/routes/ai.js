// ai.js — rotas do Personal Trainer IA (Groq)
const express          = require('express');
const router           = express.Router();
const Groq             = require('groq-sdk');
const Fuse             = require('fuse.js');
const multer           = require('multer');
const { File }         = require('buffer');
const requirePlanLevel = require('../middleware/requirePlanLevel');
const { temAcessoAoPlano } = require('../middleware/requirePlanLevel');
const cloudinary       = require('../config/cloudinary');
const conquistas       = require('../services/conquistas');
const { calcularMetas } = require('../services/nutricao');
const db               = require('../config/db');

// Multer para upload de áudio (10 MB, formatos permitidos)
const uploadAudio = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        console.log('[transcribe] mimetype:', file.mimetype);
        const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/x-m4a'];
        const isAllowed = allowed.some(type => file.mimetype.startsWith(type));
        isAllowed ? cb(null, true) : cb(new Error('Formato não suportado.'));
    },
});

// Rate limiter em memória (por userId + chave)
const _rateLimitStore = new Map();
function checkRateLimit(userId, key, max, windowMs) {
    const mapKey = `${key}:${userId}`;
    const now    = Date.now();
    const times  = (_rateLimitStore.get(mapKey) || []).filter(t => now - t < windowMs);
    times.push(now);
    _rateLimitStore.set(mapKey, times);
    return times.length <= max;
}

// Planos gymbro e black têm acesso à IA
const requireIA = requirePlanLevel(['gymbro', 'black']);
// Apenas plano Black tem acesso à avaliação corporal por foto
const requireAvaliacao = requirePlanLevel(['black']);


// Cache de exercícios do banco — expira em 24h
let _exerciseCache    = null;
let _exerciseCacheAt  = 0;
const EXERCISE_TTL_MS = 24 * 60 * 60 * 1000;

async function getExercisesCache() {
    if (_exerciseCache && Date.now() - _exerciseCacheAt < EXERCISE_TTL_MS) {
        return _exerciseCache;
    }
    const [rows] = await db.execute(
        `SELECT e.id, e.name, e.body_part
         FROM exercises e
         INNER JOIN exercise_media em ON em.exercise_id = e.id
         ORDER BY e.name`
    );
    _exerciseCache   = rows.map(r => ({ id: r.id, name: r.name, body_part: r.body_part }));
    _exerciseCacheAt = Date.now();
    return _exerciseCache;
}

async function detectIntent(groq, message) {
    try {
        const res = await groq.chat.completions.create({
            model: 'openai/gpt-oss-120b',
            messages: [
                {
                    role: 'system',
                    content: `Classifique a intenção da mensagem do usuário. Retorne APENAS um JSON:
{"intent": "workout"|"diet"|"chat", "body_parts": ["chest","back","shoulders","upper arms","upper legs","lower legs","waist","cardio"]}
body_parts só é preenchido quando intent="workout". Inclua todos os grupamentos necessários pro treino pedido.
Exemplos:
- "monta upper body" → {"intent":"workout","body_parts":["chest","back","shoulders","upper arms"]}
- "treino de perna" → {"intent":"workout","body_parts":["upper legs","lower legs"]}
- "full body" → {"intent":"workout","body_parts":["chest","back","shoulders","upper arms","upper legs","lower legs"]}
- "me faz uma dieta" → {"intent":"diet","body_parts":[]}
- "oi tudo bem" → {"intent":"chat","body_parts":[]}`
                },
                { role: 'user', content: message }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 100,
            temperature: 0,
        });
        const parsed = JSON.parse(res.choices[0].message.content);
        return {
            intent:    parsed.intent    || 'chat',
            bodyParts: Array.isArray(parsed.body_parts) ? parsed.body_parts : [],
        };
    } catch {
        return { intent: 'chat', bodyParts: [] };
    }
}

function buildExerciseBlock(all, bodyParts) {
    if (!bodyParts || bodyParts.length === 0) return '';
    const lines = [];
    for (const bp of bodyParts) {
        const names = all
            .filter(e => e.body_part === bp)
            .slice(0, 40)
            .map(e => e.name);
        if (names.length > 0) lines.push(`${bp}: ${names.join(', ')}`);
    }
    return lines.join('\n');
}

const BASE_PROMPT = `Você é um personal trainer virtual chamado GymBot, assistente oficial do FitCrew.
Você ajuda alunos com dúvidas sobre treinos, exercícios, nutrição básica e motivação.
Seja direto, motivador e use linguagem acessível. Responda sempre em português.`;

// Carrega perfil IMC do DB se a sessão não tiver (compatibilidade)
async function loadImcProfile(userId) {
    const [rows] = await db.execute(
        `SELECT * FROM imc_profile WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
        peso:                  r.peso,
        altura:                r.altura,
        imcValor:              r.imc_valor,
        idade:                 r.idade,
        sexo:                  r.sexo,
        objetivo:              r.objetivo,
        experiencia:           r.experiencia,
        diasSemana:            r.dias_semana,
        tempoPorSessao:        r.tempo_por_sessao,
        localTreino:           r.local_treino,
        lesoes:                JSON.parse(r.lesoes || '[]'),
        restricoesAlimentares: JSON.parse(r.restricoes_alimentares || '[]'),
        suplementacao:         JSON.parse(r.suplementacao || '[]'),
        hidratacao:            r.hidratacao,
    };
}

async function buildSystemPrompt(user, exerciseBlock, existingPlanNames = [], contextSummary = null) {
    // Carrega planos e dietas salvos para enriquecer o contexto da IA
    let workoutPlans = [], dietPlans = [];
    try {
        const [wRows] = await db.execute(
            'SELECT nome, descricao, exercicios_json FROM workout_plans WHERE user_id = ? ORDER BY created_at ASC',
            [user.id]
        );
        workoutPlans = wRows;
    } catch {}
    try {
        const [dRows] = await db.execute(
            'SELECT nome, objetivo_calorico, proteina_diaria_g FROM diet_plans WHERE user_id = ? ORDER BY created_at ASC',
            [user.id]
        );
        dietPlans = dRows;
    } catch {}

    let savedCtx = '';
    if (workoutPlans.length > 0) {
        const lista = workoutPlans.map(r => {
            const exs = typeof r.exercicios_json === 'string'
                ? JSON.parse(r.exercicios_json) : (r.exercicios_json || []);
            return `- ${r.nome}${r.descricao ? ': ' + r.descricao : ''} (${exs.length} exercícios)`;
        }).join('\n');
        savedCtx += `Treinos salvos do usuário:\n${lista}`;
    }
    if (dietPlans.length > 0) {
        const lista = dietPlans.map(r =>
            `- ${r.nome} (${r.objetivo_calorico || 0} kcal/dia, ${r.proteina_diaria_g || 0}g proteína)`
        ).join('\n');
        if (savedCtx) savedCtx += '\n\n';
        savedCtx += `Dietas salvas do usuário:\n${lista}`;
    }
    if (savedCtx) {
        savedCtx += '\n\nAo gerar novo treino ou dieta, considere o que já existe e continue a sequência (Treino A, B, C…).';
    }
    const planNomes = workoutPlans.map(r => r.nome);

    let nutriBloco = '';
    try {
        const [[userRow]] = await db.execute(
            'SELECT nutricao_objetivo FROM `user` WHERE id = ?', [user.id]
        );
        const objNutri = userRow?.nutricao_objetivo || null;
        const [totaisRows] = await db.execute(
            `SELECT COALESCE(SUM(kcal),0) AS kcal, COALESCE(SUM(proteina_g),0) AS proteina,
                    COALESCE(SUM(carbs_g),0) AS carbs, COALESCE(SUM(gordura_g),0) AS gordura
             FROM nutrition_log WHERE user_id = ? AND DATE(registrado_em) = CURDATE()
             AND refeicao != 'agua'`,
            [user.id]
        );
        const tot = totaisRows[0] || {};
        const imcParaMetas = user.imc
            ? { ...user.imc, objetivo: objNutri || user.imc.objetivo || '' }
            : null;
        const metas = calcularMetas(imcParaMetas);
        const objLabel = objNutri === 'cutting' ? 'Cutting' : objNutri === 'bulking' ? 'Bulking' : 'Manutenção';
        const kcalConsumido = Math.round(tot.kcal || 0);
        const saldo = kcalConsumido - metas.kcal;
        nutriBloco = `\n\nNutrição hoje (${new Date().toLocaleDateString('pt-BR')}):
Objetivo nutricional: ${objLabel}. Metas: ${metas.kcal} kcal · ${metas.proteina}g prot · ${metas.carbs}g carbs · ${metas.gordura}g gord.
Consumido até agora: ${kcalConsumido} kcal · ${parseFloat(tot.proteina||0).toFixed(1)}g prot · ${parseFloat(tot.carbs||0).toFixed(1)}g carbs · ${parseFloat(tot.gordura||0).toFixed(1)}g gord.
Saldo calórico: ${saldo >= 0 ? '+' : ''}${saldo} kcal (${kcalConsumido < metas.kcal ? 'abaixo da meta' : 'acima da meta'}).
Use estes dados para conselhos nutricionais contextualizados quando o usuário perguntar sobre alimentação.`;
    } catch (_) {}

    const imc = user.imc;
    const aval = user.avaliacaoCorporal;

    let prompt = BASE_PROMPT;

    if (!imc) {
        prompt += `

Observação: o usuário ${user.nome} ainda não preencheu o formulário de perfil IMC. Se ele pedir orientações personalizadas de treino ou nutrição, informe gentilmente que pode preencher o perfil em /imc-form para receber recomendações mais precisas.`;
        if (contextSummary) {
            prompt += `\n\nResumo da conversa anterior:\n${contextSummary}`;
        }
        prompt += `

IMPORTANTE: Você SEMPRE deve responder com um JSON válido, sem markdown, sem texto fora do JSON.

Se for uma resposta normal de chat:
{"type":"chat","message":"sua resposta aqui"}

Se o usuário pedir treino:
{"type":"workout","message":"texto explicativo","plan":{"nome":"...","descricao":"...","exercicios":[{"exercise_query":"nome em inglês compatível com ExerciseDB","nome_pt":"nome em português","series":3,"repeticoes":"8-12","descanso_segundos":60,"carga_sugerida":"moderada","equipamento":"barbell"}]}}

Se o usuário pedir dieta:
{"type":"diet","message":"texto explicativo","plan":{"nome":"...","objetivo_calorico":0,"proteina_diaria_g":0,"refeicoes":[{"nome":"...","horario_sugerido":"07:00","alimentos":[{"nome":"...","quantidade":"...","proteina_g":0,"carbo_g":0,"gordura_g":0,"kcal":0}]}]}}

O campo exercise_query SEMPRE em inglês, compatível com ExerciseDB. Nunca invente exercícios fora do padrão.
IMPORTANTE: O campo exercise_query deve ser EXATAMENTE o nome do exercício como aparece na lista fornecida — com espaços, tudo minúsculo, sem underscores. Exemplo correto: "barbell bench press". Exemplo errado: "barbell_bench_press".

REGRAS OBRIGATÓRIAS PARA GERAÇÃO DE TREINO — NÃO IGNORE:
- Para treino Upper Body: EXATAMENTE 3 exercícios de peito, 3 de costas, 2 de ombros, 2 de bíceps, 2 de tríceps = 12 exercícios no mínimo
- Para treino Lower Body: EXATAMENTE 3 de quadríceps, 2 de posterior, 2 de glúteos, 1 de panturrilha = 8 exercícios no mínimo
- Para Full Body: 2 exercícios por grupamento principal = mínimo 10 exercícios
- NUNCA monte um treino com menos exercícios do que o mínimo especificado acima
- Use APENAS exercícios da lista fornecida
- Varie os equipamentos: não use só barra, inclua halteres, cabos e peso corporal
Nomenclatura obrigatória dos planos: nomeie sempre como "Treino A — [tipo]", "Treino B — [tipo]", etc. (ex: "Treino A — Upper Body", "Treino B — Lower Body"). Nunca repita letras já usadas.`;

        if (exerciseBlock) {
            prompt += `\n\nExercícios disponíveis por grupamento muscular (use APENAS estes, com o nome exato no campo exercise_query):\n${exerciseBlock}\n\nNo campo exercise_query use EXATAMENTE o nome desta lista. Nunca invente nomes fora desta lista.`;
        }
        if (savedCtx) prompt += `\n\n${savedCtx}`;
        if (planNomes.length > 0) {
            prompt += `\n\nPlanos de treino já salvos: ${planNomes.join(', ')}. Use a próxima letra disponível na sequência alfabética.`;
        }
        if (nutriBloco) prompt += nutriBloco;
        return prompt;
    }

    const lesoes  = imc.lesoes  && imc.lesoes.length  ? imc.lesoes.join(', ')  : 'nenhuma';
    const grupos  = imc.gruposAlimentares && imc.gruposAlimentares.length ? imc.gruposAlimentares.join(', ') : 'não informado';
    const restric = imc.restricoesAlimentares && imc.restricoesAlimentares.length ? imc.restricoesAlimentares.join(', ') : 'nenhuma';
    const selet   = imc.seletividade === 'sim'
        ? `sim${imc.alimentosSeletividade ? ' — ' + imc.alimentosSeletividade : ''}`
        : 'não';
    const supl    = imc.suplementacao && imc.suplementacao.length ? imc.suplementacao.join(', ') : 'nenhuma';

    prompt += `

Perfil do usuário:
Usuário: ${user.nome}, ${imc.idade} anos, ${imc.peso}kg, ${imc.altura}cm, IMC ${imc.imcValor}.
Objetivo: ${imc.objetivo}. Experiência: ${imc.experiencia}. Treina ${imc.diasSemana} dias/semana, ${imc.tempoPorSessao} min/sessão. Local: ${imc.localTreino}.
Restrições físicas: ${lesoes}.
Alimentação: consome ${grupos}, restrições: ${restric}, seletividade alimentar: ${selet}.
Suplementação: ${supl}. Hidratação: ${imc.hidratacao}.`;

    // Inclui dados da avaliação corporal por IA se disponíveis
    if (aval && aval.composicao) {
        const c = aval.composicao;
        prompt += `

Avaliação corporal por IA (realizada em ${aval.data || 'data não registrada'}):
- Gordura corporal estimada: ${c.percentual_gordura_estimado} (margem: ${c.margem_erro})
- Massa muscular aparente: ${c.massa_muscular_aparente}
- Região de gordura predominante: ${c.regiao_predominante}
- Classificação IMC visual: ${aval.classificacao_imc_visual}
- Pontos positivos: ${(aval.pontos_positivos || []).join('; ')}
- Áreas de melhoria: ${(aval.areas_melhoria || []).join('; ')}`;
    }

    prompt += `

Use este perfil para personalizar todas as respostas. Não precisa repetir os dados do perfil na resposta, apenas use-os para contextualizar as orientações.`;

    if (contextSummary) {
        prompt += `\n\nResumo da conversa anterior:\n${contextSummary}`;
    }

    prompt += `

IMPORTANTE: Você SEMPRE deve responder com um JSON válido, sem markdown, sem texto fora do JSON.

Se for uma resposta normal de chat:
{"type":"chat","message":"sua resposta aqui"}

Se o usuário pedir treino:
{"type":"workout","message":"texto explicativo","plan":{"nome":"...","descricao":"...","exercicios":[{"exercise_query":"nome em inglês compatível com ExerciseDB","nome_pt":"nome em português","series":3,"repeticoes":"8-12","descanso_segundos":60,"carga_sugerida":"moderada","equipamento":"barbell"}]}}

Se o usuário pedir dieta:
{"type":"diet","message":"texto explicativo","plan":{"nome":"...","objetivo_calorico":0,"proteina_diaria_g":0,"refeicoes":[{"nome":"...","horario_sugerido":"07:00","alimentos":[{"nome":"...","quantidade":"...","proteina_g":0,"carbo_g":0,"gordura_g":0,"kcal":0}]}]}}

O campo exercise_query SEMPRE em inglês, compatível com ExerciseDB. Nunca invente exercícios fora do padrão.
IMPORTANTE: O campo exercise_query deve ser EXATAMENTE o nome do exercício como aparece na lista fornecida — com espaços, tudo minúsculo, sem underscores. Exemplo correto: "barbell bench press". Exemplo errado: "barbell_bench_press".

REGRAS OBRIGATÓRIAS PARA GERAÇÃO DE TREINO — NÃO IGNORE:
- Para treino Upper Body: EXATAMENTE 3 exercícios de peito, 3 de costas, 2 de ombros, 2 de bíceps, 2 de tríceps = 12 exercícios no mínimo
- Para treino Lower Body: EXATAMENTE 3 de quadríceps, 2 de posterior, 2 de glúteos, 1 de panturrilha = 8 exercícios no mínimo
- Para Full Body: 2 exercícios por grupamento principal = mínimo 10 exercícios
- NUNCA monte um treino com menos exercícios do que o mínimo especificado acima
- Use APENAS exercícios da lista fornecida
- Varie os equipamentos: não use só barra, inclua halteres, cabos e peso corporal
Nomenclatura obrigatória dos planos: nomeie sempre como "Treino A — [tipo]", "Treino B — [tipo]", etc. (ex: "Treino A — Upper Body", "Treino B — Lower Body"). Nunca repita letras já usadas.`;

    if (exerciseBlock) {
        prompt += `\n\nExercícios disponíveis por grupamento muscular (use APENAS estes, com o nome exato no campo exercise_query):\n${exerciseBlock}\n\nNo campo exercise_query use EXATAMENTE o nome desta lista. Nunca invente nomes fora desta lista.`;
    }
    if (savedCtx) prompt += `\n\n${savedCtx}`;
    if (planNomes.length > 0) {
        prompt += `\n\nPlanos de treino já salvos: ${planNomes.join(', ')}. Use a próxima letra disponível na sequência alfabética.`;
    }
    if (nutriBloco) prompt += nutriBloco;

    return prompt;
}

function fuzzyMatchExercise(query, allExercises) {
    const q = query.toLowerCase().trim();

    const exact = allExercises.find(e => e.name.toLowerCase() === q);
    if (exact) return exact.name;

    const words = q.split(/\s+/);
    const allWords = allExercises.find(e => {
        const n = e.name.toLowerCase();
        return words.every(w => n.includes(w));
    });
    if (allWords) return allWords.name;

    const fuse = new Fuse(allExercises, { keys: ['name'], threshold: 0.4 });
    const results = fuse.search(query);
    return results.length > 0 ? results[0].item.name : null;
}

// GET /ai/chat — renderiza a página do chat
router.get('/chat', requireIA, (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('pages/ai-chat', { user: req.session.user,
        seo: { title: 'GymBot Personal Trainer IA — FitCrew', canonical: '/ai/chat', robots: 'noindex, nofollow', description: 'Converse com o GymBot, seu personal trainer IA.' },
    });
});

// GET /ai/avaliacao — renderiza a página de avaliação corporal
router.get('/avaliacao', requireAvaliacao, (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('pages/ai-avaliacao', { user: req.session.user,
        seo: { title: 'Avaliação Corporal IA — FitCrew', canonical: '/ai/avaliacao', robots: 'noindex, nofollow', description: 'Avaliação corporal por inteligência artificial FitCrew.' },
    });
});

// POST /ai/avaliacao — avaliação corporal por imagem (visão via OpenRouter/GPT-4o)
router.post('/avaliacao', requireAvaliacao, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { fotoFrontal, fotoLateral, fotoPosterior } = req.body;

    if (!fotoFrontal) {
        return res.status(400).json({ erro: 'A foto frontal é obrigatória.' });
    }

    const user = req.session.user;
    const imc  = user.imc || {};

    // Monta prompt com dados do perfil
    const perfilTexto = imc.peso
        ? `Dados do aluno: ${user.nome}, ${imc.idade || '?'} anos, ${imc.peso}kg, ${imc.altura}cm, IMC ${imc.imcValor || '?'}. Objetivo: ${imc.objetivo || 'não informado'}.`
        : `Dados do aluno: ${user.nome}. Perfil IMC não preenchido.`;

    const promptTexto = `${perfilTexto}

Analise a composição corporal do aluno pela(s) foto(s) enviadas e retorne SOMENTE um JSON válido, sem markdown, sem texto fora do JSON, com exatamente esta estrutura:
{
  "composicao": {
    "percentual_gordura_estimado": "X%",
    "margem_erro": "±Y%",
    "regiao_predominante": "abdominal | membros | uniforme",
    "massa_muscular_aparente": "baixa | moderada | alta"
  },
  "classificacao_imc_visual": "string descritiva",
  "pontos_positivos": ["...", "..."],
  "areas_melhoria": ["...", "..."],
  "recomendacoes": {
    "treino": "...",
    "nutricao": "..."
  },
  "aviso": "Esta análise é estimativa visual e não substitui avaliação profissional."
}`;

    // Monta array de content com texto + imagens
    const contentArr = [{ type: 'text', text: promptTexto }];

    // Adiciona cada foto como image_url (base64 já vem do frontend)
    [fotoFrontal, fotoLateral, fotoPosterior].forEach(foto => {
        if (foto && foto.startsWith('data:image')) {
            contentArr.push({ type: 'image_url', image_url: { url: foto } });
        }
    });

    try {
        // Chama a API REST da OpenRouter (formato OpenAI vision) — Groq não tem
        // nenhum modelo com suporte a imagem disponível nesta conta.
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: 'openai/gpt-4o',
                messages: [{ role: 'user', content: contentArr }],
                temperature: 0.4,
                max_tokens: 1024
            })
        });

        const iaData = await response.json();

        if (!iaData.choices || !iaData.choices[0]) {
            console.error('Resposta inesperada da OpenRouter:', iaData);
            return res.status(500).json({ erro: 'Erro ao processar a resposta da IA.' });
        }

        const rawText = iaData.choices[0].message.content.trim();

        // Remove markdown code fences se existirem
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

        let resultado;
        try {
            resultado = JSON.parse(cleaned);
        } catch {
            console.error('Falha ao parsear JSON da IA:', rawText);
            return res.status(422).json({ erro: 'A IA não retornou um formato válido. Tente novamente com outra foto.' });
        }

        return res.json({ resultado });
    } catch (err) {
        console.error('Erro na avaliação corporal:', err.message);
        return res.status(500).json({ erro: 'Erro de conexão com a IA. Tente novamente.' });
    }
});

// POST /ai/avaliacao-salvar — persiste avaliação no DB e na sessão
router.post('/avaliacao-salvar', requireAvaliacao, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { resultado, fotoPath } = req.body;
    if (!resultado) return res.status(400).json({ erro: 'Resultado não informado.' });

    const c = resultado.composicao || {};
    try {
        await db.execute(
            `INSERT INTO body_photo
             (user_id, foto_path, consent_given, consent_at,
              gordura_total, gordura_tronco, gordura_braco, gordura_perna,
              margem_erro, analise_raw, modelo_ia)
             VALUES (?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.id,
                fotoPath || null,
                c.percentual_gordura_estimado || null,
                c.regiao_predominante || null,
                c.massa_muscular_aparente || null,
                null,
                c.margem_erro || null,
                JSON.stringify(resultado),
                'openai/gpt-4o',
            ]
        );
    } catch (err) {
        console.error('[ai/avaliacao-salvar DB]', err.message);
        // Não bloqueia — salva na sessão mesmo assim
    }

    req.session.user.avaliacaoCorporal = {
        ...resultado,
        data: new Date().toLocaleDateString('pt-BR'),
    };

    conquistas.verificarIA(req.session.user.id, 'avaliacao').catch(() => {});

    return res.json({ ok: true });
});

// POST /ai/message — envia mensagem ao Groq e persiste sessão + mensagens no DB
router.post('/message', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ reply: 'Não autorizado.' });

    const { message } = req.body;
    if (!message || !message.trim()) return res.json({ reply: 'Por favor, envie uma mensagem.' });

    const userId = req.session.user.id;

    if (!checkRateLimit(userId, 'message', 20, 60000)) {
        return res.status(429).json({ reply: 'Muitas requisições. Aguarde um momento.' });
    }

    // Garante IMC na sessão (carrega do DB se não tiver)
    if (!req.session.user.imc) {
        req.session.user.imc = await loadImcProfile(userId).catch(() => null);
    }

    try {
        // Busca ou cria sessão ativa de IA
        const [sessions] = await db.execute(
            "SELECT * FROM ai_session WHERE user_id=? AND ativa=1 ORDER BY created_at DESC LIMIT 1",
            [userId]
        );

        let sessionId, contextSummary = null;
        if (sessions.length === 0) {
            const [[ctxRows]] = await db.execute('CALL sp_contexto_ia(?)', [userId]);
            const ctx = ctxRows?.[0] || { nome: req.session.user.nome, plano: req.session.user.plano };
            const [r] = await db.execute(
                'INSERT INTO ai_session (user_id, modelo, context_snapshot) VALUES (?, ?, ?)',
                [userId, 'openai/gpt-oss-120b', JSON.stringify(ctx)]
            );
            sessionId = r.insertId;
        } else {
            sessionId = sessions[0].id;
            contextSummary = sessions[0].context_summary || null;
        }

        // Carrega histórico da sessão (últimas 20 mensagens)
        const [historico] = await db.execute(
            'SELECT role, content FROM ai_message WHERE session_id=? ORDER BY created_at ASC LIMIT 20',
            [sessionId]
        );

        // Salva mensagem do usuário
        await db.execute(
            'INSERT INTO ai_message (session_id, role, content) VALUES (?, "user", ?)',
            [sessionId, message]
        );

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const { intent, bodyParts } = await detectIntent(groq, message);
        let exerciseBlock = '';
        if (intent === 'workout' && bodyParts.length > 0) {
            const allEx = await getExercisesCache().catch(() => []);
            exerciseBlock = buildExerciseBlock(allEx, bodyParts);
        }

        const completion = await groq.chat.completions.create({
            model:      'openai/gpt-oss-120b',
            max_tokens: 4000,
            messages: [
                { role: 'system', content: await buildSystemPrompt(req.session.user, exerciseBlock, [], contextSummary) },
                ...historico.map(m => ({
                    role: m.role,
                    content: typeof m.content === 'string' && m.content.startsWith('{')
                        ? (JSON.parse(m.content).message || m.content)
                        : m.content,
                })),
                { role: 'user', content: message },
            ],
            response_format: { type: 'json_object' },
        });

        const rawText = completion.choices[0].message.content;
        const tokens  = completion.usage?.total_tokens || 0;

        let reply;
        try {
            reply = JSON.parse(rawText);
        } catch {
            reply = { type: 'chat', message: rawText };
        }
        // Salva resposta da IA
        await db.execute(
            'INSERT INTO ai_message (session_id, role, content, tokens) VALUES (?, "assistant", ?, ?)',
            [sessionId, JSON.stringify(reply), tokens]
        );
        await db.execute(
            'UPDATE ai_session SET total_mensagens=total_mensagens+2, total_tokens=total_tokens+? WHERE id=?',
            [tokens, sessionId]
        );

        // Async summary: gera a cada 10 mensagens (5 trocas) para injetar no próximo contexto
        const prevTotal = sessions[0]?.total_mensagens || 0;
        const newTotal  = prevTotal + 2;
        if (newTotal >= 10 && newTotal % 10 === 0) {
            (async () => {
                try {
                    const [msgs] = await db.execute(
                        'SELECT role, content FROM ai_message WHERE session_id=? ORDER BY created_at ASC LIMIT 30',
                        [sessionId]
                    );
                    const transcript = msgs.map(m => {
                        const role = m.role === 'user' ? 'Usuário' : 'GymBot';
                        let content = m.content;
                        try {
                            if (typeof content === 'string' && content.startsWith('{')) {
                                content = JSON.parse(content).message || content;
                            }
                        } catch {}
                        return `${role}: ${content}`;
                    }).join('\n');
                    const groqSum = new Groq({ apiKey: process.env.GROQ_API_KEY });
                    const sumRes = await groqSum.chat.completions.create({
                        model: 'openai/gpt-oss-120b',
                        max_tokens: 300,
                        messages: [
                            { role: 'system', content: 'Resuma a conversa abaixo em até 150 palavras, focando em: objetivos do usuário, planos discutidos ou gerados, preferências e restrições mencionadas. Seja conciso e objetivo.' },
                            { role: 'user', content: transcript }
                        ]
                    });
                    const summary = sumRes.choices[0].message.content;
                    await db.execute('UPDATE ai_session SET context_summary=? WHERE id=?', [summary, sessionId]);
                } catch (err) {
                    console.error('[ai] async summary:', err.message);
                }
            })();
        }

        return res.json({ reply });
    } catch (err) {
        console.error('Erro ao chamar Groq:', err.message);
        return res.json({ reply: 'Desculpe, não consegui processar sua mensagem. Tente novamente.' });
    }
});

// POST /ai/plan/save — persiste plano gerado pela IA no banco
router.post('/plan/save', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { type, plan } = req.body;
    if (!type || !plan) return res.status(400).json({ erro: 'type e plan são obrigatórios.' });

    const userId = req.session.user.id;

    try {
        if (type === 'workout') {
            const exercicios = plan.exercicios || [];

            const nomeLower = (plan.nome || '').toLowerCase();
            const bodyParts = exercicios.map(e => (e.equipamento || '') + ' ' + (e.exercise_query || '')).join(' ').toLowerCase();
            const isUpper = nomeLower.includes('upper') ||
                exercicios.some(e => ['chest', 'back', 'shoulders', 'upper arms'].includes((e.body_part || '').toLowerCase()));
            const isLower = nomeLower.includes('lower') || nomeLower.includes('perna') ||
                exercicios.some(e => ['upper legs', 'lower legs'].includes((e.body_part || '').toLowerCase()));

            const minimo = isUpper ? 8 : 6;

            if (exercicios.length < minimo) {
                return res.status(400).json({ ok: false, error: 'Treino incompleto, peça à IA para adicionar mais exercícios.' });
            }

            const allEx = await getExercisesCache().catch(() => []);
            const normalized = exercicios.map(ex => {
                const match = fuzzyMatchExercise(ex.exercise_query, allEx);
                return { ...ex, exercise_query: match || ex.exercise_query };
            });

            const [result] = await db.execute(
                `INSERT INTO workout_plans (user_id, nome, descricao, exercicios_json, criado_por_ia, created_at)
                 VALUES (?, ?, ?, ?, 1, NOW())
                 ON DUPLICATE KEY UPDATE exercicios_json=VALUES(exercicios_json), updated_at=NOW()`,
                [
                    userId,
                    plan.nome || 'Plano de treino IA',
                    plan.descricao || null,
                    JSON.stringify(normalized),
                ]
            );
            conquistas.verificarIA(userId, 'treino').catch(() => {});
            return res.json({ ok: true, id: result.insertId || null });
        }

        if (type === 'diet') {
            const [result] = await db.execute(
                `INSERT INTO diet_plans (user_id, nome, objetivo_calorico, proteina_diaria_g, refeicoes_json, criado_por_ia, created_at)
                 VALUES (?, ?, ?, ?, ?, 1, NOW())
                 ON DUPLICATE KEY UPDATE refeicoes_json=VALUES(refeicoes_json), updated_at=NOW()`,
                [
                    userId,
                    plan.nome || 'Plano alimentar IA',
                    plan.objetivo_calorico || null,
                    plan.proteina_diaria_g || null,
                    JSON.stringify(plan.refeicoes || []),
                ]
            );
            conquistas.verificarIA(userId, 'dieta').catch(() => {});
            return res.json({ ok: true, id: result.insertId || null });
        }

        return res.status(400).json({ erro: `Tipo desconhecido: ${type}` });
    } catch (err) {
        console.error('[ai/plan/save]', err.message);
        return res.status(500).json({ erro: 'Erro ao salvar plano.' });
    }
});

// GET /ai/conversations — lista todas as sessões do usuário
router.get('/conversations', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autorizado.' });
    const userId = req.session.user.id;
    try {
        const [rows] = await db.execute(
            'SELECT id, ativa, context_summary, total_mensagens, created_at FROM ai_session WHERE user_id=? ORDER BY created_at DESC LIMIT 20',
            [userId]
        );
        return res.json({ conversations: rows });
    } catch (err) {
        console.error('[ai/conversations]', err.message);
        return res.status(500).json({ error: 'Erro ao listar conversas.' });
    }
});

// GET /ai/conversations/:id/messages — mensagens de uma sessão específica
router.get('/conversations/:id/messages', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autorizado.' });
    const userId    = req.session.user.id;
    const sessionId = parseInt(req.params.id);
    try {
        const [sessions] = await db.execute(
            'SELECT id FROM ai_session WHERE id=? AND user_id=?',
            [sessionId, userId]
        );
        if (!sessions.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
        const [messages] = await db.execute(
            'SELECT role, content, created_at FROM ai_message WHERE session_id=? ORDER BY created_at ASC',
            [sessionId]
        );
        return res.json({ messages });
    } catch (err) {
        console.error('[ai/conversations/:id/messages]', err.message);
        return res.status(500).json({ error: 'Erro ao carregar mensagens.' });
    }
});

// POST /ai/conversations/new — cria nova sessão e desativa a atual
router.post('/conversations/new', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autorizado.' });
    const userId = req.session.user.id;
    try {
        await db.execute('UPDATE ai_session SET ativa=0 WHERE user_id=?', [userId]);
        let ctx = { nome: req.session.user.nome, plano: req.session.user.plano };
        try {
            const [[ctxSet]] = await db.execute('CALL sp_contexto_ia(?)', [userId]);
            ctx = ctxSet?.[0] || ctx;
        } catch {}
        const [r] = await db.execute(
            'INSERT INTO ai_session (user_id, modelo, context_snapshot) VALUES (?, ?, ?)',
            [userId, 'openai/gpt-oss-120b', JSON.stringify(ctx)]
        );
        return res.json({ ok: true, sessionId: r.insertId });
    } catch (err) {
        console.error('[ai/conversations/new]', err.message);
        return res.status(500).json({ error: 'Erro ao criar conversa.' });
    }
});

// DELETE /ai/conversations/:id — deleta sessão e suas mensagens
router.delete('/conversations/:id', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autorizado.' });
    const userId    = req.session.user.id;
    const sessionId = parseInt(req.params.id);
    try {
        const [sessions] = await db.execute(
            'SELECT id, ativa FROM ai_session WHERE id = ? AND user_id = ?',
            [sessionId, userId]
        );
        if (!sessions.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
        const wasActive = !!sessions[0].ativa;
        await db.execute('DELETE FROM ai_message WHERE session_id = ?', [sessionId]);
        await db.execute('DELETE FROM ai_session WHERE id = ?', [sessionId]);
        return res.json({ ok: true, wasActive });
    } catch (err) {
        console.error('[ai/conversations/:id/delete]', err.message);
        return res.status(500).json({ error: 'Erro ao deletar conversa.' });
    }
});

// POST /ai/conversations/:id/activate — ativa uma sessão específica
router.post('/conversations/:id/activate', requireIA, async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autorizado.' });
    const userId    = req.session.user.id;
    const sessionId = parseInt(req.params.id);
    try {
        const [sessions] = await db.execute(
            'SELECT id FROM ai_session WHERE id=? AND user_id=?',
            [sessionId, userId]
        );
        if (!sessions.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
        await db.execute('UPDATE ai_session SET ativa=0 WHERE user_id=?', [userId]);
        await db.execute('UPDATE ai_session SET ativa=1 WHERE id=?', [sessionId]);
        return res.json({ ok: true });
    } catch (err) {
        console.error('[ai/conversations/:id/activate]', err.message);
        return res.status(500).json({ error: 'Erro ao ativar conversa.' });
    }
});

// POST /ai/transcribe — transcreve áudio com Groq Whisper
router.post('/transcribe', requireIA, (req, res) => {
    if (!req.session.user) return res.status(401).json({ ok: false, error: 'Não autorizado.' });

    uploadAudio.single('audio')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, error: err.message });
        if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum áudio enviado.' });

        const userId = req.session.user.id;
        if (!checkRateLimit(userId, 'transcribe', 10, 60000)) {
            return res.status(429).json({ ok: false, error: 'Muitas requisições. Aguarde um momento.' });
        }

        try {
            const audioFile = new File(
                [req.file.buffer],
                req.file.originalname || 'audio.webm',
                { type: req.file.mimetype }
            );
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const transcricao = await groq.audio.transcriptions.create({
                file:            audioFile,
                model:           'whisper-large-v3-turbo',
                language:        'pt',
                response_format: 'json',
            });
            return res.json({ ok: true, texto: transcricao.text });
        } catch (err) {
            console.error('[ai/transcribe]', err.message);
            return res.status(500).json({ ok: false, error: 'Erro ao transcrever.' });
        }
    });
});

// ── Análise de foto por IA (comida ou corporal) ───────────────────────────────
// OpenAI Vision (gpt-4o) como fonte primária, com fallback em texto via Groq
// se a chamada à OpenAI falhar — a resposta ao cliente sempre tem a mesma forma.

const uploadFotoAnalise = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 8 * 1024 * 1024, files: 3 },
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
        else cb(new Error('Formato inválido. Use JPEG, PNG ou WebP.'));
    },
});

// Aceita tanto "foto" (uma imagem — tela de nutrição) quanto "fotos" (até 3 —
// avaliação corporal: frontal, lateral e posterior na mesma análise).
const camposFotoAnalise = uploadFotoAnalise.fields([
    { name: 'foto',  maxCount: 1 },
    { name: 'fotos', maxCount: 3 },
]);

// Upload manual (não via CloudinaryStorage) pra foto só subir DEPOIS de passar
// pelos magic bytes. Mesmas opções da rota antiga de nutrição.
function uploadFotoNutricao(buffer, userId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: 'gymbros/nutricao',
                transformation: [{ width: 800, height: 800, crop: 'limit', quality: 80 }],
                public_id: `nutricao_${userId || 'anon'}_${Date.now()}`,
            },
            (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
    });
}

// Confere a assinatura binária real do arquivo — o mimetype do multer vem do
// Content-Type declarado pelo cliente e é falsificável; magic bytes não.
function detectarMimeReal(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
}

const PROMPT_ANALISE_COMIDA = `Você é um nutricionista virtual. Olhe a foto da refeição e identifique os alimentos visíveis.
Para cada alimento, estime de forma aproximada a porção, as calorias e os macronutrientes.
Deixe sempre claro que os valores são uma ESTIMATIVA visual — não uma medição exata — já que dependem de fatores que a foto não mostra (porção real, modo de preparo, ingredientes ocultos).
Responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, exatamente neste formato:
{
  "alimentos": [
    {"nome": "...", "quantidade_estimada": "...", "peso_estimado_g": 0, "kcal": 0, "proteina_g": 0, "carbs_g": 0, "gordura_g": 0, "fibra_g": 0, "confianca": "alta|media|baixa"}
  ],
  "observacao": "frase curta reforçando que é uma estimativa aproximada"
}`;

const PROMPT_ANALISE_CORPORAL = `Você é um assistente de fitness dando uma estimativa visual geral a partir da(s) foto(s) corporal(is) enviada(s) por um aluno de academia.
Regras obrigatórias:
- NUNCA use linguagem de diagnóstico médico (ex: não diga "você tem X% de gordura corporal", prefira "estimativa visual aproximada de X%").
- NUNCA apresente números como medição exata — sempre acompanhados de uma margem de erro explícita.
- Foque em observações construtivas sobre treino e composição corporal aparente, nunca em julgamento estético.
- Não comente sobre condições de saúde nem faça qualquer sugestão que soe como diagnóstico.
Responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, exatamente neste formato:
{
  "composicao": {
    "percentual_gordura_estimado": "X%",
    "margem_erro": "±Y%",
    "regiao_predominante": "abdominal | membros | uniforme",
    "massa_muscular_aparente": "baixa | moderada | alta"
  },
  "classificacao_imc_visual": "string descritiva curta",
  "pontos_positivos": ["...", "..."],
  "areas_melhoria": ["...", "..."],
  "recomendacoes": {
    "treino": "...",
    "nutricao": "..."
  },
  "aviso": "será sobrescrito pelo servidor — não precisa preencher com cuidado"
}`;

// Disclaimer fixo, sempre aplicado no servidor (nunca confiamos só no prompt
// pro modelo lembrar de incluir o aviso médico/legal)
const AVISO_CORPORAL_FIXO = 'Esta é uma estimativa visual gerada por IA a partir da foto enviada — não é uma avaliação médica, diagnóstico ou medição precisa. Para uma avaliação real de composição corporal e saúde, consulte um profissional de educação física ou de saúde.';

function parseJsonIA(texto) {
    if (!texto) return null;
    const limpo = texto.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(limpo); } catch { return null; }
}

function fallbackComida(motivo) {
    return {
        alimentos: [],
        observacao: `Não foi possível analisar a foto agora (${motivo}). Tente novamente em instantes ou registre a refeição manualmente.`,
    };
}

function fallbackCorporal() {
    return {
        composicao: {
            percentual_gordura_estimado: null,
            margem_erro: null,
            regiao_predominante: null,
            massa_muscular_aparente: null,
        },
        classificacao_imc_visual: null,
        pontos_positivos: [],
        areas_melhoria: [],
        recomendacoes: {
            treino:   'Tente enviar a foto novamente em alguns instantes.',
            nutricao: 'Tente enviar a foto novamente em alguns instantes.',
        },
        aviso: AVISO_CORPORAL_FIXO,
    };
}

// Garante a MESMA forma de resposta independente da fonte (openai ou fallback)
function normalizarResultadoComida(resultado) {
    if (!resultado || typeof resultado !== 'object') return fallbackComida('sem dados');
    return {
        alimentos:   Array.isArray(resultado.alimentos) ? resultado.alimentos : [],
        observacao:  typeof resultado.observacao === 'string' ? resultado.observacao : fallbackComida('sem dados').observacao,
    };
}

function normalizarResultadoCorporal(resultado) {
    const base = fallbackCorporal();
    if (!resultado || typeof resultado !== 'object') return base;

    const c   = (resultado.composicao && typeof resultado.composicao === 'object') ? resultado.composicao : {};
    const rec = (resultado.recomendacoes && typeof resultado.recomendacoes === 'object' && !Array.isArray(resultado.recomendacoes))
        ? resultado.recomendacoes
        : {};

    return {
        composicao: {
            percentual_gordura_estimado: typeof c.percentual_gordura_estimado === 'string' ? c.percentual_gordura_estimado : null,
            margem_erro:                 typeof c.margem_erro === 'string' ? c.margem_erro : null,
            regiao_predominante:         typeof c.regiao_predominante === 'string' ? c.regiao_predominante : null,
            massa_muscular_aparente:     ['baixa', 'moderada', 'alta'].includes(c.massa_muscular_aparente) ? c.massa_muscular_aparente : null,
        },
        classificacao_imc_visual: typeof resultado.classificacao_imc_visual === 'string' ? resultado.classificacao_imc_visual : null,
        pontos_positivos:         Array.isArray(resultado.pontos_positivos) ? resultado.pontos_positivos : [],
        areas_melhoria:           Array.isArray(resultado.areas_melhoria) ? resultado.areas_melhoria : [],
        recomendacoes: {
            treino:   typeof rec.treino === 'string' ? rec.treino : base.recomendacoes.treino,
            nutricao: typeof rec.nutricao === 'string' ? rec.nutricao : base.recomendacoes.nutricao,
        },
        aviso: AVISO_CORPORAL_FIXO, // nunca vem do modelo
    };
}

// Chama a API REST da OpenAI (mesmo estilo REST já usado pra OpenRouter em /avaliacao).
// `imagens` é um array de { mime, base64 } — uma foto (comida) ou até três (corporal).
async function chamarOpenAIVision(imagens, prompt) {
    const content = [
        { type: 'text', text: prompt },
        ...imagens.map(img => ({
            type: 'image_url',
            image_url: { url: `data:${img.mime};base64,${img.base64}` },
        })),
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content }],
            temperature: 0.4,
            max_tokens: 1024,
        }),
    });
    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`OpenAI ${response.status}: ${errBody.slice(0, 300)}`);
    }
    const data  = await response.json();
    const texto = data.choices?.[0]?.message?.content;
    if (!texto) throw new Error('Resposta vazia da OpenAI.');
    return texto;
}

// Groq não tem modelo de visão disponível nesta conta (mesmo motivo já documentado
// em /avaliacao), então o fallback é só texto: admite a limitação em vez de inventar
// uma "análise" que não pode ter visto a foto.
async function chamarGroqFallback(tipo) {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = tipo === 'comida'
        ? 'A análise visual de uma foto de refeição falhou. Gere APENAS um JSON válido, sem markdown: {"alimentos":[],"observacao":"<frase curta e honesta dizendo que não foi possível analisar a foto agora e sugerindo tentar de novo ou registrar manualmente>"}'
        : `A análise visual de uma foto corporal falhou. Não invente medidas: os campos de composição devem vir null.
Gere APENAS um JSON válido, sem markdown, exatamente com estas chaves:
{"composicao":{"percentual_gordura_estimado":null,"margem_erro":null,"regiao_predominante":null,"massa_muscular_aparente":null},"classificacao_imc_visual":null,"pontos_positivos":[],"areas_melhoria":[],"recomendacoes":{"treino":"<frase curta sugerindo tentar novamente em instantes>","nutricao":"<frase curta sugerindo tentar novamente em instantes>"},"aviso":"aviso curto"}`;
    const completion = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
    });
    return completion.choices?.[0]?.message?.content || null;
}

// Cada tela mantém o gate que já tinha: nutrição exige apenas plano ativo,
// avaliação corporal continua restrita ao plano black.
async function podeAnalisar(user, tipo) {
    // ExpoTech (temporário): DISABLE_PLAN_GATES=true libera a análise por
    // foto sem exigir plano. Reverter apagando a env var após o evento.
    if (process.env.DISABLE_PLAN_GATES === 'true') return true;
    if (tipo === 'corporal') return temAcessoAoPlano(user, ['black']);
    return !!user.plano;
}

// POST /ai/analise-foto — multipart/form-data:
//   tipo  = "comida" | "corporal"
//   foto  = uma imagem  (ou)  fotos = até 3 imagens (avaliação corporal)
router.post('/analise-foto', (req, res) => {
    if (!req.session.user) return res.status(401).json({ ok: false, erro: 'Não autorizado.' });

    camposFotoAnalise(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, erro: err.message });

        const tipo = req.body.tipo;
        if (!['comida', 'corporal'].includes(tipo)) {
            return res.status(400).json({ ok: false, erro: 'Parâmetro "tipo" deve ser "comida" ou "corporal".' });
        }

        if (!(await podeAnalisar(req.session.user, tipo))) {
            return res.status(403).json({ ok: false, erro: 'Seu plano não inclui esta análise.' });
        }

        // Corporal analisa até 3 ângulos na mesma chamada; comida é sempre uma foto
        const maxArquivos = tipo === 'corporal' ? 3 : 1;
        const arquivos = [
            ...(req.files?.foto  || []),
            ...(req.files?.fotos || []),
        ].slice(0, maxArquivos);
        if (!arquivos.length) return res.status(400).json({ ok: false, erro: 'Nenhuma foto enviada.' });

        // Magic bytes — nunca confiar só no Content-Type declarado pelo cliente
        const imagens = [];
        for (const arquivo of arquivos) {
            const mimeReal = detectarMimeReal(arquivo.buffer);
            if (!mimeReal) {
                return res.status(400).json({ ok: false, erro: 'Arquivo não é uma imagem válida (JPEG, PNG ou WebP).' });
            }
            imagens.push({ mime: mimeReal, base64: arquivo.buffer.toString('base64') });
        }

        // A tela de nutrição exibe a foto de volta, então ela vai pro Cloudinary —
        // mas só DEPOIS dos magic bytes, pra arquivo inválido nunca ser hospedado.
        let fotoUrl = null;
        if (tipo === 'comida') {
            try {
                const upload = await uploadFotoNutricao(arquivos[0].buffer, req.session.user.id);
                fotoUrl = upload.secure_url;
            } catch (uploadErr) {
                console.error('[ai/analise-foto] upload Cloudinary falhou:', uploadErr.message);
            }
        }

        const prompt = tipo === 'comida' ? PROMPT_ANALISE_COMIDA : PROMPT_ANALISE_CORPORAL;
        const normalizar = tipo === 'comida' ? normalizarResultadoComida : normalizarResultadoCorporal;

        let resultado;
        let fonte = 'openai';
        try {
            const textoIA = await chamarOpenAIVision(imagens, prompt);
            const parsed  = parseJsonIA(textoIA);
            if (!parsed) throw new Error('Resposta da OpenAI não é um JSON válido.');
            resultado = normalizar(parsed);
        } catch (err) {
            console.error('[ai/analise-foto] OpenAI falhou, tentando fallback Groq:', err.message);
            fonte = 'groq_fallback';
            let parsedFallback = null;
            try {
                parsedFallback = parseJsonIA(await chamarGroqFallback(tipo));
            } catch (fallbackErr) {
                console.error('[ai/analise-foto] Groq fallback também falhou:', fallbackErr.message);
            }
            resultado = normalizar(parsedFallback);
        }

        return res.json({ ok: true, tipo, fonte, fotoUrl, resultado });
    });
});

// Extrai o número de strings como "18%", "18-20%" ou "±3%" — as colunas
// correspondentes em body_photo são DECIMAL, não texto.
function extrairNumero(valor) {
    if (valor === null || valor === undefined) return null;
    const m = String(valor).match(/\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// POST /ai/analise-foto/salvar — persiste o resultado da análise.
// Só vale pra "corporal": os alimentos da análise de comida continuam sendo
// gravados item a item por /api/nutricao/item, depois que o aluno ajusta os pesos.
router.post('/analise-foto/salvar', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ ok: false, erro: 'Não autorizado.' });

    const { tipo, resultado, fonte, consentimento } = req.body;

    if (tipo !== 'corporal') {
        return res.status(400).json({
            ok: false,
            erro: 'Só análises do tipo "corporal" são persistidas aqui. Alimentos são salvos via /api/nutricao/item.',
        });
    }
    if (!resultado || typeof resultado !== 'object') {
        return res.status(400).json({ ok: false, erro: 'Resultado não informado.' });
    }
    if (!(await temAcessoAoPlano(req.session.user, ['black']))) {
        return res.status(403).json({ ok: false, erro: 'Seu plano não inclui esta análise.' });
    }

    // Normaliza de novo no servidor: o corpo vem do cliente e pode ter sido editado
    const analise = normalizarResultadoCorporal(resultado);
    const c = analise.composicao;

    let erroPersistencia = null;
    try {
        await db.execute(
            `INSERT INTO body_photo
             (user_id, foto_path, consent_given, consent_at,
              gordura_total, margem_erro,
              classificacao_imc_visual, massa_muscular_aparente, regiao_predominante,
              pontos_positivos, areas_melhoria, recomendacoes,
              analise_raw, modelo_ia)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.id,
                null,                                 // decisão consciente: a imagem corporal não é armazenada
                consentimento ? 1 : 0,
                consentimento ? new Date() : null,
                extrairNumero(c.percentual_gordura_estimado),
                extrairNumero(c.margem_erro),
                analise.classificacao_imc_visual,
                c.massa_muscular_aparente,            // ENUM('baixa','moderada','alta') | NULL
                c.regiao_predominante,
                JSON.stringify(analise.pontos_positivos),
                JSON.stringify(analise.areas_melhoria),
                JSON.stringify(analise.recomendacoes),
                JSON.stringify(analise),
                fonte === 'groq_fallback' ? 'groq-fallback' : 'gpt-4o',
            ]
        );
    } catch (err) {
        erroPersistencia = err;
        console.error('[ai/analise-foto/salvar DB]', err.message);
    }

    // Efeitos colaterais que já funcionavam continuam valendo mesmo se o INSERT falhar
    req.session.user.avaliacaoCorporal = {
        ...analise,
        data: new Date().toLocaleDateString('pt-BR'),
    };
    conquistas.verificarIA(req.session.user.id, 'avaliacao').catch(() => {});

    if (erroPersistencia) {
        return res.status(500).json({
            ok: false,
            persistido: false,
            erro: 'A análise foi gerada, mas não foi possível salvá-la no histórico.',
        });
    }

    return res.json({ ok: true, persistido: true });
});

module.exports = router;
