'use strict';
const db     = require('../config/db');
const crypto = require('crypto');
const { encryptCpf, decryptCpf, hmacCpf } = require('../services/cripto');

class User {
    static async findById(id) {
        const [rows] = await db.execute('SELECT * FROM user WHERE id = ?', [id]);
        return rows[0] || null;
    }

    // cpf: string de dígitos (já normalizada pelo chamador ou não)
    static async findByCpf(cpf) {
        const cpfLimpo = cpf.replace(/\D/g, '');
        const hmac = hmacCpf(cpfLimpo);
        const [rows] = await db.execute('SELECT * FROM user WHERE cpf_hmac = ? LIMIT 1', [hmac]);
        const user = rows[0] || null;
        if (user && user.cpf_enc) user.cpf = decryptCpf(user.cpf_enc);
        return user;
    }

    static async findByEmail(email) {
        const [rows] = await db.execute('SELECT * FROM user WHERE email = ?', [email]);
        return rows[0] || null;
    }

    static async findByNome(nome) {
        const [rows] = await db.execute('SELECT * FROM user WHERE nome = ?', [nome]);
        return rows[0] || null;
    }

    // Tenta CPF → email → nome, filtrando apenas usuários ativos ou pendente_exclusao
    static async findActiveByIdentifier(identifier) {
        const cpfNorm = identifier.replace(/\D/g, '');
        let user = null;
        if (/^\d{11}$/.test(cpfNorm)) {
            const hmac = hmacCpf(cpfNorm);
            const [r] = await db.execute("SELECT * FROM user WHERE cpf_hmac = ? AND status IN ('ativo','pendente_exclusao')", [hmac]);
            user = r[0] || null;
        }
        if (!user) {
            const [r2] = await db.execute("SELECT * FROM user WHERE email = ? AND status IN ('ativo','pendente_exclusao')", [identifier.toLowerCase()]);
            user = r2[0] || null;
        }
        if (!user) {
            const [r3] = await db.execute("SELECT * FROM user WHERE nome = ? AND status IN ('ativo','pendente_exclusao')", [identifier]);
            user = r3[0] || null;
        }
        if (user && user.cpf_enc) user.cpf = decryptCpf(user.cpf_enc);
        return user;
    }

    static async findAll({ page = 1, limit = 15, status = null, busca = null, plano = null } = {}) {
        const offset = (page - 1) * limit;
        let where = 'WHERE 1=1';
        const params = [];
        if (busca)  { where += ' AND (u.nome LIKE ? OR u.cpf LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
        if (plano)  { where += ' AND p.slug = ?'; params.push(plano); }
        if (status) { where += ' AND u.status = ?'; params.push(status); }
        const sql = `SELECT u.id, u.nome, u.email, u.cpf, u.cpf_enc, u.status, u.created_at AS createdAt,
                            p.nome AS plano, p.id AS planoId, p.slug AS planoSlug
                     FROM user u
                     LEFT JOIN user_plan up ON up.user_id = u.id AND up.status = 'ativo'
                     LEFT JOIN plan p ON p.id = up.plan_id
                     ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const [rows] = await db.execute(sql, params);
        return rows;
    }

    static async count({ status = null, busca = null, plano = null } = {}) {
        let where = 'WHERE 1=1';
        const params = [];
        if (busca)  { where += ' AND (u.nome LIKE ? OR u.cpf LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
        if (plano)  { where += ' AND p.slug = ?'; params.push(plano); }
        if (status) { where += ' AND u.status = ?'; params.push(status); }
        const sql = `SELECT COUNT(*) AS total FROM user u
                     LEFT JOIN user_plan up ON up.user_id = u.id AND up.status = 'ativo'
                     LEFT JOIN plan p ON p.id = up.plan_id ${where}`;
        const [[{ total }]] = await db.execute(sql, params);
        return Number(total);
    }

    // cpf chega em texto puro (dígitos); é criptografado aqui e nunca salvo em claro
    static async create({ nome, cpf, email, senha_hash, cep, logradouro, numero, complemento, bairro, cidade, estado }) {
        const qr_token = crypto.randomBytes(32).toString('hex');
        const cpfLimpo = cpf.replace(/\D/g, '');
        const cpfEnc   = encryptCpf(cpfLimpo);
        const cpfHmac  = hmacCpf(cpfLimpo);
        const [result] = await db.execute(
            `INSERT INTO user (nome, cpf, cpf_enc, cpf_hmac, email, senha_hash, cep, logradouro, numero, complemento, bairro, cidade, estado, qr_token)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [nome, null, cpfEnc, cpfHmac, email, senha_hash, cep || null, logradouro || null, numero || null,
             complemento || null, bairro || null, cidade || null, estado || null, qr_token]
        );
        return result.insertId;
    }

    static async update(id, fields) {
        const allowed = ['nome', 'email', 'cep', 'telefone', 'profile_photo', 'status',
                         'last_seen', 'notification_interval_days', 'last_imc_update',
                         'last_avaliacao_update', 'senha_hash', 'instagram_username',
                         'username', 'bio', 'medalhas_destaque'];
        const entries = Object.entries(fields).filter(([k, v]) => allowed.includes(k) && v !== undefined);
        if (!entries.length) return;
        const sets   = entries.map(([k]) => `${k} = ?`);
        const values = entries.map(([, v]) => v);
        await db.execute(`UPDATE user SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    }

    static async delete(id) {
        await db.execute('DELETE FROM user WHERE id = ?', [id]);
    }

    static async getActivePlan(userId) {
        const [rows] = await db.execute(
            `SELECT p.* FROM plan p
             JOIN user_plan up ON up.plan_id = p.id
             WHERE up.user_id = ? AND up.status = 'ativo'
             LIMIT 1`,
            [userId]
        );
        return rows[0] || null;
    }
}

module.exports = User;
