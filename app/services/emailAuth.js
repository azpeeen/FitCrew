'use strict';

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function enviarRecuperacaoSenha({ to, nome, link }) {
  if (!resend) {
    throw new Error('RESEND_API_KEY não definida.');
  }

  if (!to || typeof to !== 'string') {
    throw new Error('Email de destino inválido.');
  }

  if (!link || typeof link !== 'string') {
    throw new Error('Link de recuperação inválido.');
  }

  const nomeSafe = escapeHtml(nome || 'aluno');
  const logoUrl  = `${BASE_URL}/images/logo.png`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redefinir senha — FitCrew</title>
</head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
          style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);">

          <tr>
            <td style="background:#C98B1D;padding:32px 40px;text-align:center;">
              <img src="${logoUrl}" alt="FitCrew" width="64" height="64" style="display:block;margin:0 auto 12px;border-radius:14px;">
              <h1 style="margin:0;font-size:1.6rem;font-weight:800;color:#000;letter-spacing:-0.5px;">FitCrew</h1>
              <p style="margin:4px 0 0;font-size:0.82rem;color:rgba(0,0,0,0.6);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Plataforma Fitness</p>
            </td>
          </tr>

          <tr>
            <td style="background:#1a1a1a;padding:48px 40px;">
              <p style="margin:0 0 8px;font-size:0.875rem;color:#888;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;">Olá, ${nomeSafe}!</p>

              <h2 style="margin:0 0 16px;font-size:1.5rem;font-weight:800;color:#f0f0f0;line-height:1.3;">Redefinição de senha</h2>

              <p style="margin:0 0 28px;font-size:0.95rem;color:#aaa;line-height:1.7;">
                Recebemos uma solicitação para redefinir a senha da sua conta no
                <strong style="color:#f0f0f0;">FitCrew</strong>. Clique no botão abaixo para criar uma nova senha.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td style="border-radius:12px;background:#C98B1D;">
                    <a href="${link}" style="display:inline-block;padding:16px 40px;font-size:1rem;font-weight:800;color:#000;text-decoration:none;border-radius:12px;letter-spacing:-0.3px;">
                      Redefinir minha senha &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#111;border-radius:10px;padding:16px 20px;border:1px solid #222;">
                    <p style="margin:0;font-size:0.82rem;color:#888;line-height:1.6;">
                      Este link é válido por <strong style="color:#f0f0f0;">1 hora</strong> e pode ser usado apenas uma vez.<br>
                      Se você não solicitou a redefinição de senha, <strong style="color:#f0f0f0;">ignore este email</strong> — sua senha permanece a mesma.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;font-size:0.75rem;color:#555;text-align:center;line-height:1.6;">
                Se o botão não funcionar, copie e cole este link no navegador:<br>
                <a href="${link}" style="color:#C98B1D;word-break:break-all;">${link}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#111;padding:24px 40px;border-top:1px solid #222;">
              <p style="margin:0;font-size:0.78rem;color:#555;line-height:1.8;text-align:center;">
                <strong style="color:#888;">FitCrew</strong><br>
                contato@fitcrew.net &bull; fitcrew.net
              </p>
              <p style="margin:16px 0 0;font-size:0.72rem;color:#444;text-align:center;">
                Você está recebendo este email porque solicitou a redefinição de senha.
                Este é um email automático — não responda.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Olá, ${nome || 'aluno'}

Recebemos uma solicitação para redefinir a senha da sua conta no FitCrew.
Acesse o link abaixo para criar uma nova senha (válido por 1 hora, uso único):

${link}

Se você não solicitou a redefinição de senha, ignore este email — sua senha permanece a mesma.

Equipe FitCrew`;

  const response = await resend.emails.send({
    from: 'FitCrew <noreply@fitcrew.net>',
    reply_to: 'contato@fitcrew.net',
    to: [to],
    subject: 'Redefinição de senha — FitCrew',
    html,
    text,
  });

  if (response?.error) {
    console.error('[emailAuth] erro resend:', response.error);
    throw new Error(response.error.message);
  }

  console.log('[emailAuth] recuperação de senha enviada:', to);

  return { ok: true, id: response?.data?.id || null };
}

module.exports = { enviarRecuperacaoSenha };
