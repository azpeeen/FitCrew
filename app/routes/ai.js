// ai.js — rotas do Personal Trainer IA (Groq)
const express          = require('express');
const router           = express.Router();
const Groq             = require('groq-sdk');
const Fuse             = require('fuse.js');
const multer           = require('multer');
const { File }         = require('buffer');
const requirePlanLevel = require('../middleware/requirePlanLevel');
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

// Cria tabelas de planos IA se não existirem
async function initPlanTables() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS workout_plans (
            id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id         INT UNSIGNED NOT NULL,
            nome            VARCHAR(255) NOT NULL,
            descricao       TEXT NULL,
            exercicios_json JSON NOT NULL,
            criado_por_ia   TINYINT(1) NOT NULL DEFAULT 0,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_workout_plan_user_nome (user_id, nome),
            CONSTRAINT fk_workout_plans_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS diet_plans (
            id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id           INT UNSIGNED NOT NULL,
            nome              VARCHAR(255) NOT NULL,
            objetivo_calorico INT UNSIGNED NULL,
            proteina_diaria_g INT UNSIGNED NULL,
            refeicoes_json    JSON NOT NULL,
            criado_por_ia     TINYINT(1) NOT NULL DEFAULT 0,
            created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_diet_plan_user_nome (user_id, nome),
            CONSTRAINT fk_diet_plans_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
}
initPlanTables().catch(err => console.error('[ai] initPlanTables:', err.message));

// Adiciona coluna context_summary à ai_session se ainda não existir (errno 1060 = duplicate column)
(async () => {
    try {
        await db.execute('ALTER TABLE ai_session ADD COLUMN context_summary TEXT NULL');
    } catch (err) {
        if (err.errno !== 1060) console.error('[ai] alter ai_session:', err.message);
    }
})();

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
            model: 'llama-3.1-8b-instant',
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

const BASE_PROMPT = `Você é um personal trainer virtual chamado GymBot, assistente oficial do GymBros.
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
        seo: { title: 'GymBot Personal Trainer IA — GymBros', canonical: '/ai/chat', robots: 'noindex, nofollow', description: 'Converse com o GymBot, seu personal trainer IA.' },
    });
});

// GET /ai/avaliacao — renderiza a página de avaliação corporal
router.get('/avaliacao', requireIA, (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('pages/ai-avaliacao', { user: req.session.user,
        seo: { title: 'Avaliação Corporal IA — GymBros', canonical: '/ai/avaliacao', robots: 'noindex, nofollow', description: 'Avaliação corporal por inteligência artificial GymBros.' },
    });
});

// POST /ai/avaliacao — avaliação corporal por imagem (visão do LLaMA 4)
router.post('/avaliacao', requireIA, async (req, res) => {
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
        // Chama diretamente a API REST da Groq (formato OpenAI vision)
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [{ role: 'user', content: contentArr }],
                temperature: 0.4,
                max_tokens: 1024
            })
        });

        const groqData = await response.json();

        if (!groqData.choices || !groqData.choices[0]) {
            console.error('Resposta inesperada da Groq:', groqData);
            return res.status(500).json({ erro: 'Erro ao processar a resposta da IA.' });
        }

        const rawText = groqData.choices[0].message.content.trim();

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
router.post('/avaliacao-salvar', requireIA, async (req, res) => {
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
                'llama-4-scout',
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
                [userId, 'llama-3.3-70b-versatile', JSON.stringify(ctx)]
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
            model:      'llama-3.3-70b-versatile',
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
                        model: 'llama-3.1-8b-instant',
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
            [userId, 'llama-3.3-70b-versatile', JSON.stringify(ctx)]
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

module.exports = router;
