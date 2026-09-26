'use strict';

const multer = require('multer');

const TIPOS_IMAGEM  = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const TIPOS_VIDEO    = ['video/mp4', 'video/quicktime', 'video/webm'];
const TIPOS_ACEITOS  = [...TIPOS_IMAGEM, ...TIPOS_VIDEO];

const uploadPost = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (TIPOS_ACEITOS.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado. Use JPG, PNG, WebP, GIF, MP4 ou WebM.'));
        }
    },
});

module.exports = { uploadPost, TIPOS_IMAGEM, TIPOS_VIDEO };
