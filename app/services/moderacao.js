"use strict";

const axios = require("axios");
const FormData = require("form-data");

const API_USER = process.env.SIGHTENGINE_API_USER;
const API_SECRET = process.env.SIGHTENGINE_API_SECRET;

function configurado() {
  return Boolean(API_USER && API_SECRET);
}

function naoConfigurado(retorno) {
  console.warn(
    "[moderacao] Sightengine não configurado — aprovando por padrão",
  );
  return retorno;
}

function erroApi(err) {
  const mensagem = err?.response?.status
    ? `status ${err.response.status}`
    : err?.message || "erro desconhecido";
  console.error("[moderacao] Erro na API:", mensagem);
  return { decisao: "aprovado", motivo: "api_error" };
}

// ---------- imagem ----------

function avaliarImagem(d) {
  const n = d.nudity || {};
  const sc = n.suggestive_classes || {};
  const nc = n.context || {};
  const of = d.offensive || {};
  const g = d.gore || {};
  const sh = d["self-harm"] || {};
  const vi = d.violence || {};
  const vc = vi.classes || {};
  const wp = d.weapon || {};
  const wc = wp.classes || {};
  const tx = d.text || {};

  // Rejeitar
  if ((n.sexual_activity || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if ((n.sexual_display || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if ((n.erotica || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if ((g.prob || 0) > 0.7) return { decisao: "rejeitado", motivo: "gore" };
  if ((sh.prob || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "self_harm" };
  if ((vi.prob || 0) > 0.7 && (vc.combat_sport || 0) <= 0.5)
    return { decisao: "rejeitado", motivo: "violence" };
  if ((of.middle_finger || 0) > 0.7)
    return { decisao: "rejeitado", motivo: "offensive" };
  if ((of.nazi || 0) > 0.5) return { decisao: "rejeitado", motivo: "hate" };
  if ((of.supremacist || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "hate" };
  if ((of.terrorist || 0) > 0.5)
    return { decisao: "rejeitado", motivo: "hate" };
  if ((tx.profanity || []).length > 0)
    return { decisao: "rejeitado", motivo: "profanity" };
  if ((tx["self-harm"] || []).length > 0)
    return { decisao: "rejeitado", motivo: "self_harm" };
  if ((tx.personal || []).length > 0)
    return { decisao: "rejeitado", motivo: "personal_data" };
  if ((tx["content-trade"] || []).length > 0)
    return { decisao: "rejeitado", motivo: "content_trade" };

  // Revisão manual
  const verySuggestive = (n.very_suggestive || 0) > 0.4;
  const gymException =
    (sc.male_chest || 0) > 0.7 && (nc.indoor_other || 0) > 0.5;
  if (verySuggestive && !gymException)
    return { decisao: "revisao", motivo: "suggestive" };
  if ((n.suggestive || 0) > 0.6)
    return { decisao: "revisao", motivo: "suggestive" };
  if ((g.prob || 0) > 0.4) return { decisao: "revisao", motivo: "gore" };
  if ((vi.prob || 0) > 0.4) return { decisao: "revisao", motivo: "violence" };
  if ((sh.prob || 0) > 0.3) return { decisao: "revisao", motivo: "self_harm" };
  if ((wc.firearm || 0) > 0.5 && (vc.combat_sport || 0) <= 0.5)
    return { decisao: "revisao", motivo: "weapon" };

  return { decisao: "aprovado", motivo: null };
}

async function moderarImagem(url) {
  if (!configurado())
    return naoConfigurado({ decisao: "aprovado", motivo: null, score: null });
  try {
    const response = await axios.get(
      "https://api.sightengine.com/1.0/check.json",
      {
        params: {
          url,
          models:
            "nudity-2.1,weapon,offensive-2.0,text-content,gore-2.0,text,qr-content,violence,self-harm",
          api_user: API_USER,
          api_secret: API_SECRET,
        },
        timeout: 10000,
      },
    );
    const { decisao, motivo } = avaliarImagem(response.data);
    return { decisao, motivo, score: response.data };
  } catch (err) {
    return { ...erroApi(err), score: null };
  }
}

// ---------- vídeo ----------

function piorDosFrames(frames) {
  return frames.reduce(
    (acc, frame) => {
      const n = frame.nudity || {};
      acc.sexual_activity = Math.max(
        acc.sexual_activity,
        n.sexual_activity || 0,
      );
      acc.sexual_display = Math.max(acc.sexual_display, n.sexual_display || 0);
      acc.erotica = Math.max(acc.erotica, n.erotica || 0);
      acc.very_suggestive = Math.max(
        acc.very_suggestive,
        n.very_suggestive || 0,
      );
      acc.suggestive = Math.max(acc.suggestive, n.suggestive || 0);
      acc.male_chest = Math.max(
        acc.male_chest,
        (n.suggestive_classes || {}).male_chest || 0,
      );
      acc.indoor = Math.max(acc.indoor, (n.context || {}).indoor_other || 0);
      acc.combat_sport = Math.max(
        acc.combat_sport,
        (frame.violence?.classes || {}).combat_sport || 0,
      );
      acc.gore = Math.max(acc.gore, frame.gore?.prob || 0);
      acc.selfharm = Math.max(acc.selfharm, frame["self-harm"]?.prob || 0);
      acc.violence = Math.max(acc.violence, frame.violence?.prob || 0);
      acc.firearm = Math.max(
        acc.firearm,
        (frame.weapon?.classes || {}).firearm || 0,
      );
      return acc;
    },
    {
      sexual_activity: 0,
      sexual_display: 0,
      erotica: 0,
      very_suggestive: 0,
      suggestive: 0,
      male_chest: 0,
      indoor: 0,
      combat_sport: 0,
      gore: 0,
      selfharm: 0,
      violence: 0,
      firearm: 0,
    },
  );
}

function avaliarPior(p) {
  // Rejeitar
  if (p.sexual_activity > 0.5)
    return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if (p.sexual_display > 0.5)
    return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if (p.erotica > 0.5) return { decisao: "rejeitado", motivo: "nudity_sexual" };
  if (p.gore > 0.7) return { decisao: "rejeitado", motivo: "gore" };
  if (p.selfharm > 0.5) return { decisao: "rejeitado", motivo: "self_harm" };
  if (p.violence > 0.7 && p.combat_sport <= 0.5)
    return { decisao: "rejeitado", motivo: "violence" };

  // Revisão
  const gymException = p.male_chest > 0.7 && p.indoor > 0.5;
  if (p.very_suggestive > 0.4 && !gymException)
    return { decisao: "revisao", motivo: "suggestive" };
  if (p.suggestive > 0.6) return { decisao: "revisao", motivo: "suggestive" };
  if (p.gore > 0.4) return { decisao: "revisao", motivo: "gore" };
  if (p.violence > 0.4) return { decisao: "revisao", motivo: "violence" };
  if (p.selfharm > 0.3) return { decisao: "revisao", motivo: "self_harm" };
  if (p.firearm > 0.5 && p.combat_sport <= 0.5)
    return { decisao: "revisao", motivo: "weapon" };

  return { decisao: "aprovado", motivo: null };
}

async function moderarVideo(url) {
  if (!configurado())
    return naoConfigurado({ decisao: "aprovado", motivo: null, score: null });
  try {
    const response = await axios.get(
      "https://api.sightengine.com/1.0/video/check-sync.json",
      {
        params: {
          stream_url: url,
          models: "nudity-2.1,weapon,offensive-2.0,gore-2.0,violence,self-harm",
          api_user: API_USER,
          api_secret: API_SECRET,
        },
        timeout: 90000,
      },
    );
    const frames = response.data?.data?.frames || [];
    if (!frames.length)
      return { decisao: "aprovado", motivo: null, score: response.data };
    const pior = piorDosFrames(frames);
    const { decisao, motivo } = avaliarPior(pior);
    return { decisao, motivo, score: response.data };
  } catch (err) {
    return { ...erroApi(err), score: null };
  }
}

// ---------- texto ----------

const CATEGORIAS = {
  username: "profanity,personal,extremism",
  bio: "profanity,personal,extremism,self-harm,violence",
  post: "profanity,personal,link,extremism,weapon,self-harm,violence,spam,content-trade,money-transaction",
  comentario:
    "profanity,personal,extremism,self-harm,violence,spam,content-trade",
  chat: "profanity,spam,content-trade,violence,self-harm,money-transaction",
};

function avaliarTexto(data, contexto) {
  const profanity = data.profanity?.matches || [];
  const personal = data.personal?.matches || [];
  const extremism = data.extremism?.matches || [];
  const selfharm = data["self-harm"]?.matches || [];
  const contentTrade = data["content-trade"]?.matches || [];
  const moneyTx = data["money-transaction"]?.matches || [];
  const violence = data.violence?.matches || [];
  const spam = data.spam?.matches || [];

  // Rejeitar
  if (extremism.length > 0)
    return { decisao: "rejeitado", motivo: "extremism", matches: extremism };
  if (selfharm.length > 0)
    return { decisao: "rejeitado", motivo: "self_harm", matches: selfharm };
  if (contentTrade.length > 0)
    return {
      decisao: "rejeitado",
      motivo: "content_trade",
      matches: contentTrade,
    };
  if (moneyTx.length > 0)
    return {
      decisao: "rejeitado",
      motivo: "money_transaction",
      matches: moneyTx,
    };

  const profHeavy = profanity.filter(
    (m) => m.intensity === "high" || m.intensity === "medium",
  );
  if (profHeavy.length > 0)
    return { decisao: "rejeitado", motivo: "profanity", matches: profHeavy };

  // dados pessoais: legítimos em bio (telefone da academia);
  // @menções são um recurso do produto em comentários, não vazamento de dado
  const personalRelevante =
    contexto === "comentario"
      ? personal.filter((m) => m.type !== "username")
      : personal;
  if (personalRelevante.length > 0 && contexto !== "bio")
    return {
      decisao: "rejeitado",
      motivo: "personal_data",
      matches: personalRelevante,
    };

  // Revisão
  if (violence.length > 0)
    return { decisao: "revisao", motivo: "violence", matches: violence };
  if (spam.length > 0)
    return { decisao: "revisao", motivo: "spam", matches: spam };

  return { decisao: "aprovado", motivo: null, matches: [] };
}

async function moderarTexto(texto, contexto) {
  if (!configurado())
    return naoConfigurado({ decisao: "aprovado", motivo: null, matches: [] });
  const categories = CATEGORIAS[contexto] || CATEGORIAS.comentario;
  try {
    const form = new FormData();
    form.append("text", texto);
    form.append("lang", "pt,en");
    form.append("categories", categories);
    form.append("mode", "rules");
    form.append("api_user", API_USER);
    form.append("api_secret", API_SECRET);

    const response = await axios.post(
      "https://api.sightengine.com/1.0/text/check.json",
      form,
      { headers: form.getHeaders(), timeout: 8000 },
    );
    return avaliarTexto(response.data, contexto);
  } catch (err) {
    return { ...erroApi(err), matches: [] };
  }
}

module.exports = { moderarImagem, moderarVideo, moderarTexto };
