'use strict';

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrapEmail(corpo) {
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f0f0f;color:#f0f0f0;margin:0;padding:0}
.wrap{max-width:560px;margin:40px auto;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden}
.header{background:#141414;padding:24px 32px;border-bottom:1px solid #2a2a2a;text-align:center}
.header h1{margin:0;font-size:1.2rem;color:#C98B1D}
.body{padding:32px}
.body p{margin:0 0 16px;line-height:1.6;color:#ccc;font-size:0.9rem}
.body strong{color:#f0f0f0}
.cred-box{background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin:20px 0;font-family:monospace;font-size:0.85rem}
.cred-row{display:flex;justify-content:space-between;margin-bottom:8px;color:#ccc}
.cred-row:last-child{margin-bottom:0}
.cred-label{color:#888}
.cred-val{color:#f0f0f0;font-weight:600}
.btn-wrap{text-align:center;margin:28px 0}
.btn{display:inline-block;background:#C98B1D;color:#000;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:0.9rem}
.footer{padding:20px 32px;border-top:1px solid #2a2a2a;font-size:0.75rem;color:#555;text-align:center}
.badge{display:inline-block;background:rgba(201,139,29,0.12);border:1px solid rgba(201,139,29,0.25);color:#C98B1D;padding:2px 12px;border-radius:20px;font-size:0.72rem;letter-spacing:1px;text-transform:uppercase}
</style></head><body>
<section class="wrap">
    <section class="header">
        <h1>FitCrew</h1>
        <span class="badge">Portal da Academia</span>
    </section>
    <section class="body">${corpo}</section>
    <section class="footer">FitCrew &mdash; Plataforma Fitness SaaS &bull; <a href="${BASE_URL}" style="color:#555">fitcrew.net</a></section>
</section>
</body></html>`;
}

async function send({ to, subject, html }) {
    if (!resend) {
        console.warn('[emailGymAdmin] RESEND_API_KEY não definida — email não enviado:', subject);
        return { ok: false, skipped: true };
    }
    const response = await resend.emails.send({
        from: 'FitCrew <noreply@fitcrew.net>',
        reply_to: 'contato@fitcrew.net',
        to: [to],
        subject,
        html,
    });
    if (response?.error) throw new Error(response.error.message);
    console.log('[emailGymAdmin] enviado para', to, '—', subject);
    return { ok: true, id: response?.data?.id || null };
}

// ── 1. Boas-vindas: gestor ativado pelo admin GymBros ────────────────────────
async function sendBoasVindas({ gestor, gym, senhaTemporaria }) {
    const corpo = `
<p>Olá, <strong>${esc(gestor.nome)}</strong>! 👋</p>
<p>Sua academia <strong>${esc(gym.nome)}</strong> foi ativada na plataforma FitCrew.</p>
<p>Acesse o Portal da Academia com as credenciais abaixo:</p>
<section class="cred-box">
    <section class="cred-row"><span class="cred-label">E-mail</span><span class="cred-val">${esc(gestor.email)}</span></section>
    <section class="cred-row"><span class="cred-label">Senha temporária</span><span class="cred-val">${esc(senhaTemporaria)}</span></section>
</section>
<section class="btn-wrap"><a href="${BASE_URL}/gym-admin/login" class="btn">Acessar Portal</a></section>
<p style="font-size:0.8rem;color:#666">Por segurança, altere sua senha no primeiro acesso.</p>`;

    return send({
        to: gestor.email,
        subject: `Bem-vindo ao FitCrew — acesse o portal de ${esc(gym.nome)}`,
        html: wrapEmail(corpo),
    });
}

// ── 2. Aguardando aprovação: cadastro self-service recebido ──────────────────
async function sendAguardandoAprovacao({ gestor, gym }) {
    const corpo = `
<p>Olá, <strong>${esc(gestor.nome)}</strong>!</p>
<p>Recebemos o cadastro da academia <strong>${esc(gym.nome)}</strong> na plataforma FitCrew.</p>
<p>Nossa equipe irá analisar as informações e ativar o portal em breve. Você receberá suas credenciais de acesso por e-mail assim que a aprovação for concluída.</p>
<p style="color:#888;font-size:0.85rem">Caso tenha dúvidas, responda este e-mail ou entre em contato com nossa equipe.</p>`;

    return send({
        to: gestor.email,
        subject: 'Cadastro recebido — sua academia será ativada em breve',
        html: wrapEmail(corpo),
    });
}

// ── 3. Alerta interno: nova academia pendente de aprovação ───────────────────
async function sendAlertaAdminNovaAcademia({ gym, gestor, adminAcademiaId }) {
    const corpo = `
<p>Uma nova academia aguarda aprovação:</p>
<section class="cred-box">
    <section class="cred-row"><span class="cred-label">Academia</span><span class="cred-val">${esc(gym.nome)}</span></section>
    <section class="cred-row"><span class="cred-label">Cidade</span><span class="cred-val">${esc(gym.cidade || '—')}</span></section>
    <section class="cred-row"><span class="cred-label">Gestor</span><span class="cred-val">${esc(gestor.nome)}</span></section>
    <section class="cred-row"><span class="cred-label">E-mail</span><span class="cred-val">${esc(gestor.email)}</span></section>
</section>
<section class="btn-wrap"><a href="${BASE_URL}/admin/academias/${adminAcademiaId}" class="btn">Aprovar no Painel</a></section>`;

    return send({
        to: 'admin@fitcrew.net',
        subject: `Nova academia aguardando aprovação: ${esc(gym.nome)}`,
        html: wrapEmail(corpo),
    });
}

module.exports = { sendBoasVindas, sendAguardandoAprovacao, sendAlertaAdminNovaAcademia };
