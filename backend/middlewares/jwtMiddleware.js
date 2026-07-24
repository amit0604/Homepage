// jwtMiddleware.js
const jwt = require('jsonwebtoken');

const jwtMiddleware = (req, res, next) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '')?.trim();
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const isAdminMiddleware = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        console.log("not auth")
        return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
};

/** Pinger: admins or members of LDAP_PINGER_GROUP_DN (claim pingerAccess on JWT). */
const pingerAccessMiddleware = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.user.isAdmin || req.user.pingerAccess) {
        return next();
    }
    return res.status(403).json({ error: 'Forbidden: Pinger access required' });
};

/** Pinger mutations: admins only (LDAP pinger group is read-only). */
const pingerWriteMiddleware = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.user.isAdmin) {
        return next();
    }
    return res.status(403).json({ message: 'Pinger is read-only for your account. Admin access is required to change hosts.' });
};

module.exports = { jwtMiddleware, isAdminMiddleware, pingerAccessMiddleware, pingerWriteMiddleware };