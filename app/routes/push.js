// push.js — Web Push VAPID (F10)
const express  = require('express');
const router   = express.Router();
const webpush  = require('web-push');
const db       = require('../config/db');

webpush.setVapidDetails(
    process.env.VAPID_MAILTO,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);


async function deleteSub(endpoint) {
    try {
        await db.execute('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    } catch {}
}

async function sendToSubs(subs, payload) {
    return Promise.allSettled(subs.map(sub =>
        webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
        ).catch(async err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
                await deleteSub(sub.endpoint);
            }
            throw err;
        })
    ));
}

// ── GET /push/vapid-public-key ────────────────────────────────────────────────
router.get('/vapid-public-key', (_req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── POST /push/subscribe ──────────────────────────────────────────────────────
router.post('/subscribe', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ erro: 'Dados inválidos.' });
    }

    try {
        await db.execute(
            `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               p256dh       = VALUES(p256dh),
               auth         = VALUES(auth),
               device_label = VALUES(device_label)`,
            [req.session.user.id, endpoint, keys.p256dh, keys.auth, deviceLabel || null]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[push/subscribe]', err.message);
        return res.status(500).json({ erro: 'Erro ao salvar subscription.' });
    }
});

// ── POST /push/unsubscribe ────────────────────────────────────────────────────
router.post('/unsubscribe', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ erro: 'Endpoint obrigatório.' });

    try {
        await db.execute(
            'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
            [endpoint, req.session.user.id]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[push/unsubscribe]', err.message);
        return res.status(500).json({ erro: 'Erro ao remover subscription.' });
    }
});

// ── POST /internal/push/send ──────────────────────────────────────────────────
router.post('/send', async (req, res) => {
    if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
        return res.status(403).json({ erro: 'Não autorizado.' });
    }

    const { user_id, title, body, url } = req.body;
    if (!user_id || !title || !body) {
        return res.status(400).json({ erro: 'user_id, title e body são obrigatórios.' });
    }

    try {
        const [subs] = await db.execute(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
            [user_id]
        );
        if (!subs.length) return res.json({ ok: true, sent: 0 });

        const payload = JSON.stringify({ title, body, url: url || '/' });
        const results = await sendToSubs(subs, payload);
        return res.json({ ok: true, sent: results.filter(r => r.status === 'fulfilled').length });
    } catch (err) {
        console.error('[push/send]', err.message);
        return res.status(500).json({ erro: 'Erro ao enviar push.' });
    }
});

// ── POST /internal/push/checkin-alert ────────────────────────────────────────
// Cron: dispara para usuários sem check-in há 3+ dias (tz America/Sao_Paulo)
router.post('/checkin-alert', async (req, res) => {
    if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
        return res.status(403).json({ erro: 'Não autorizado.' });
    }

    try {
        const [users] = await db.execute(`
            SELECT ps.user_id,
                   DATEDIFF(CONVERT_TZ(NOW(), '+00:00', '-03:00'), MAX(c.data)) AS dias
            FROM push_subscriptions ps
            LEFT JOIN checkin c ON c.user_id = ps.user_id
            GROUP BY ps.user_id
            HAVING dias >= 3 OR dias IS NULL
        `);

        if (!users.length) return res.json({ ok: true, notificados: 0 });

        const BATCH = 50;
        let notificados = 0;

        for (let i = 0; i < users.length; i += BATCH) {
            const batch = users.slice(i, i + BATCH);
            const results = await Promise.allSettled(batch.map(async u => {
                const dias = u.dias != null ? u.dias : '3+';
                const [subs] = await db.execute(
                    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
                    [u.user_id]
                );
                const payload = JSON.stringify({
                    title: '💪 Você não treina há ' + dias + ' dia' + (dias !== 1 ? 's' : '') + '.',
                    body:  'Que tal voltar hoje? Seu progresso está esperando!',
                    url:   '/treinos',
                });
                await sendToSubs(subs, payload);
            }));
            notificados += results.filter(r => r.status === 'fulfilled').length;
        }

        return res.json({ ok: true, notificados });
    } catch (err) {
        console.error('[push/checkin-alert]', err.message);
        return res.status(500).json({ erro: 'Erro ao processar alertas.' });
    }
});

module.exports = router;
