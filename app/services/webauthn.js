'use strict';

const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'GymBros';
const RP_ID  = process.env.WEBAUTHN_RP_ID  || 'gymbros.app.br';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://gymbros.app.br';

// base64 → base64url
function toBase64URL(b64) {
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function gerarOpcoesRegistro(user) {
    return generateRegistrationOptions({
        rpName:   RP_NAME,
        rpID:     RP_ID,
        // v9+: userID must be Uint8Array, not string
        userID:   Buffer.from(String(user.id), 'utf8'),
        userName:        user.email,
        userDisplayName: user.nome,
        attestationType: 'none',
        authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification:        'required',
            residentKey:             'preferred',
        },
        excludeCredentials: user.webauthn_credential_id
            ? [{ id: toBase64URL(user.webauthn_credential_id), type: 'public-key' }]
            : [],
    });
}

async function verificarRegistro(response, expectedChallenge) {
    return verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin:          ORIGIN,
        expectedRPID:            RP_ID,
        requireUserVerification: true,
    });
}

async function gerarOpcoesAutenticacao(user) {
    return generateAuthenticationOptions({
        rpID:             RP_ID,
        userVerification: 'required',
        allowCredentials: user.webauthn_credential_id
            ? [{ id: toBase64URL(user.webauthn_credential_id), type: 'public-key' }]
            : [],
    });
}

// publicKey stored in DB as standard base64 (Buffer.toString('base64'))
// counter is the numeric counter from DB
async function verificarAutenticacao(response, expectedChallenge, publicKeyB64, counter) {
    return verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID:   RP_ID,
        // v9+: credential object instead of authenticator
        credential: {
            id:        response.id,                             // base64url from client
            publicKey: Buffer.from(publicKeyB64, 'base64'),     // Uint8Array
            counter,
        },
        requireUserVerification: true,
    });
}

module.exports = {
    gerarOpcoesRegistro,
    verificarRegistro,
    gerarOpcoesAutenticacao,
    verificarAutenticacao,
};
