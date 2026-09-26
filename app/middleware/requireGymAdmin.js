'use strict';

function requireGymAdmin(req, res, next) {
    if (req.session && req.session.gymAdmin) {
        return next();
    }
    return res.redirect('/gym-admin/login?next=' + encodeURIComponent(req.originalUrl));
}

module.exports = requireGymAdmin;
