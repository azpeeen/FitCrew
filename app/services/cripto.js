'use strict';

const crypto = require('crypto');

const CPF_SECRET = process.env.CPF_SECRET;
const ALGORITHM  = 'aes-256-gcm';
const IV_LEN     = 12;  // 96 bits para GCM

/**
 * Criptografa CPF com AES-256-GCM.
 * Retorna string base64: iv:authTag:ciphertext
 */
function encryptCpf(cpf) {
  if (!CPF_SECRET) throw new Error('CPF_SECRET não configurado');
  const key = Buffer.from(CPF_SECRET, 'hex');
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const enc = Buffer.concat([cipher.update(cpf, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

/**
 * Descriptografa CPF.
 * Retorna string do CPF ou null em caso de erro.
 */
function decryptCpf(encrypted) {
  if (!encrypted || !CPF_SECRET) return null;
  try {
    const key = Buffer.from(CPF_SECRET, 'hex');
    const [ivB64, tagB64, encB64] = encrypted.split(':');
    const iv  = Buffer.from(ivB64,  'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Gera HMAC-SHA256 do CPF para buscas no banco.
 * Sempre o mesmo resultado para o mesmo CPF.
 */
function hmacCpf(cpf) {
  if (!CPF_SECRET) throw new Error('CPF_SECRET não configurado');
  return crypto
    .createHmac('sha256', Buffer.from(CPF_SECRET, 'hex'))
    .update(cpf)
    .digest('hex');
}

module.exports = { encryptCpf, decryptCpf, hmacCpf };
