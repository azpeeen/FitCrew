'use strict';

const multer = require('multer');

const TIPOS_IMAGEM = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const TIPOS_AUDIO   = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/x-m4a'];

const uploadChat = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const isImagem = TIPOS_IMAGEM.includes(file.mimetype);
        const isAudio  = TIPOS_AUDIO.some(t => file.mimetype.startsWith(t));
        if (isImagem || isAudio) return cb(null, true);
        cb(new Error('Tipo de arquivo não suportado.'));
    },
});

module.exports = { uploadChat, TIPOS_IMAGEM, TIPOS_AUDIO };
