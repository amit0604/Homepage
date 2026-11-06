// ldapRoutes.js
const express = require('express');
const { signAppToken } = require('../utils/appJwt');
const rateLimit = require('express-rate-limit');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const {
  stripConfiguredEmailSuffix,
  placeholderEmailForUsername,
  buildLdapLoginCandidates,
} = require('../utils/userEmailDomain');
const ldapSingleton = require('../services/ldapSingleton');
const { collections } = require('../repositories/jsonStore');
const router = express.Router();
const activeDirectoryService = ldapSingleton;
const User = collections.users;
activeDirectoryService.initActiveDirectory();

const loginLimiter = rateLimit({
  validate: { xForwardedForHeader: false },
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Too many login attempts; try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Guesses against one account are counted whatever address they claim to come from. */
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `account:${String(req.body?.username ?? '').trim().toLowerCase().slice(0, 200)}`,
  validate: false,
  message: { error: 'Too many failed attempts for this account; try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

class DirectoryTimeoutError extends Error {}

/** An unreachable directory must not leave people waiting on the sign-in screen. */
function authenticateWithTimeout(username, password) {
  const ms = Number(process.env.LDAP_LOGIN_TIMEOUT_MS) > 0 ? Number(process.env.LDAP_LOGIN_TIMEOUT_MS) : 8000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DirectoryTimeoutError('Directory timed out')), ms);
  });
  return Promise.race([activeDirectoryService.authenticate(username, password), timeout]).finally(() => clearTimeout(timer));
}

function escapeLdapFilterValue(str) {
  return String(str)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

/** LDAP filter: users who are direct members of the configured admin group. */
function memberOfFilterForAdminGroup() {
  const dn = (process.env.LDAP_ADMIN_GROUP_DN || '').trim();
  if (dn) {
    const esc = escapeLdapFilterValue(dn);
    return `(&(objectCategory=user)(objectClass=user)(memberOf=${esc}))`;
  }
  const base = process.env.LDAP_SEARCH_BASE || '';
  return `(&(objectCategory=user)(objectClass=user)(memberOf=CN=homepage-admin,${base}))`;
}

function groupDnLower(g) {
  return String(g.dn || g.distinguishedName || '').trim().toLowerCase();
}

function userHasPingerAccess(isAdmin, groups) {
  if (isAdmin) return true;
  const pingerDn = (process.env.LDAP_PINGER_GROUP_DN || '').trim().toLowerCase();
  if (!pingerDn || !Array.isArray(groups)) return false;
  return groups.some((g) => groupDnLower(g) === pingerDn);
}

// JWT Login Route
router.post("/login", loginLimiter, accountLimiter, async (req, res) => {
    const { username, password } = req.body || {};

    // An empty password would be an anonymous bind on many directory servers, which always "succeeds".
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        return res.status(401).json({ error: 'Authentication failed' });
    }
    
    try {
        const localAdminUsername = (process.env.LOCAL_ADMIN_USERNAME || '').trim();
        const localAdminPassword = process.env.LOCAL_ADMIN_PASSWORD;
        const localAdminSlotActive = Boolean(
            localAdminUsername &&
            localAdminPassword != null &&
            String(localAdminPassword).length > 0,
        );

        const inputTrim = String(username ?? '').trim();
        const normalizedUsername = stripConfiguredEmailSuffix(inputTrim);
        const identityMatchesLocalAdmin =
            localAdminSlotActive &&
            (inputTrim.toLowerCase() === localAdminUsername.toLowerCase()
                || normalizedUsername.toLowerCase() === localAdminUsername.toLowerCase());

        const isLocalAdminLogin =
            identityMatchesLocalAdmin && password === localAdminPassword;

        /** When local admin env is set, that account is local-only: never fall through to LDAP. */
        if (identityMatchesLocalAdmin && !isLocalAdminLogin) {
            return res.status(401).json({ error: 'Authentication failed' });
        }

        if (isLocalAdminLogin) {
            const localUsername = localAdminUsername;
            const localUser = await User.findOne((record) => record.username === localUsername);

            if (localUser) {
                await User.updateById(localUser._id, { isAdmin: true, groups: ['local-admin'] });
            } else {
                await User.insert({
                    username: localUsername,
                    displayName: 'Local Admin',
                    email: `${localUsername}@local`,
                    groups: ['local-admin'],
                    isAdmin: true,
                });
            }

            const localRow = await User.findOne((record) => record.username === localUsername);
            const localDisplay = (localRow && localRow.displayName) || 'Local Admin';
            const pingerAccess = true;
            const token = signAppToken({
                  username: localUsername,
                  isAdmin: true,
                  displayName: localDisplay,
                  pingerAccess,
                });

            return res.json({
                message: "Login successful",
                user: {
                    username: localUsername,
                    isAdmin: true,
                    pingerAccess,
                },
                token
            });
        }

        const candidates = buildLdapLoginCandidates(inputTrim);
        let authenticatedAs = null;
        for (let i = 0; i < candidates.length; i += 1) {
            const c = candidates[i];
            // eslint-disable-next-line no-await-in-loop
            const ok = await authenticateWithTimeout(c, password);
            if (ok) {
                authenticatedAs = c;
                break;
            }
        }

        if (!authenticatedAs) {
            return res.status(401).json({ error: 'Authentication failed' });
        }

        const adUser = await activeDirectoryService.findAdUserByAnyCandidate(
            [authenticatedAs, ...candidates],
        );
        const accountName = adUser && adUser.sAMAccountName
            ? String(adUser.sAMAccountName).trim()
            : String(authenticatedAs).split(/[@\\]/).pop() || String(username).trim();
        const display = (adUser && (adUser.displayName || adUser.cn)) || accountName;
        const upn = adUser && adUser.userPrincipalName
            ? String(adUser.userPrincipalName).trim()
            : null;

        let groups = [];
        try {
            if (adUser) {
                groups = await activeDirectoryService.findUserGroupsForAdUser(adUser);
            } else {
                groups = await activeDirectoryService.findUserGroups(authenticatedAs);
            }
        } catch (e) {
            console.error('Group membership lookup failed:', e.message);
            groups = [];
        }
        if (!Array.isArray(groups)) {
            groups = [];
        }
        const groupNames = groups.map((group) => group.cn).filter(Boolean);
        const adminDn = (process.env.LDAP_ADMIN_GROUP_DN || '').trim().toLowerCase();
        const localUser = await User.findOne(
            (u) => u.username === accountName
                || (upn && u.username === upn)
                || u.username === authenticatedAs,
        );
        let isAdmin = Boolean(localUser?.isAdmin);
        if (!isAdmin && adminDn) {
          isAdmin = groups.some((g) => groupDnLower(g) === adminDn);
        } else if (!isAdmin) {
          isAdmin = groups.some((group) => group.cn === 'Domain Admins');
        }

        if (localUser) {
            await User.updateById(localUser._id, {
                username: accountName,
                displayName: display,
                email: (adUser && adUser.mail) || (upn ? upn : placeholderEmailForUsername(accountName)),
                groups: groupNames,
                isAdmin,
            });
        } else {
            await User.insert({
                username: accountName,
                displayName: display,
                email: (adUser && adUser.mail) || (upn ? upn : placeholderEmailForUsername(accountName)),
                groups: groupNames,
                isAdmin,
            });
        }

        const pingerAccess = userHasPingerAccess(isAdmin, groups);
        const token = signAppToken({
              username: accountName,
              isAdmin,
              displayName: display,
              pingerAccess,
            });

        res.json({
            message: "Login successful",
            user: {
                username: accountName,
                isAdmin,
                pingerAccess,
            },
            token
        });
    } catch (error) {
        if (error instanceof DirectoryTimeoutError) {
            return res.status(503).json({ error: 'The directory server is not responding. Try again shortly.' });
        }
        console.error('Login Error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// Everyone a ticket can be assigned to: directory admins, the local admin, and stored admins.
// The directory being unreachable must not stop admins from working.
router.get("/admin-users", jwtMiddleware, isAdminMiddleware, async (req, res) => {
    try {
        let ldapNames = [];
        let ldapError = null;
        try {
            const adminUsers = await activeDirectoryService.findUsers(memberOfFilterForAdminGroup());
            ldapNames = (adminUsers || []).map((user) => user.sAMAccountName).filter(Boolean);
        } catch (error) {
            ldapError = error;
            console.error('Admin Users Error:', error.message);
        }

        const storedAdmins = await User.find((user) => user.isAdmin);
        const localAdmin = (process.env.LOCAL_ADMIN_USERNAME || '').trim();
        const seen = new Set();
        const usernames = [...ldapNames, ...storedAdmins.map((user) => user.username), localAdmin]
            .filter(Boolean)
            .filter((name) => {
                const key = String(name).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        if (usernames.length === 0) {
            return ldapError
                ? res.status(502).json({ error: "Server error", message: ldapError.message })
                : res.status(404).json({ error: 'No admin users found' });
        }
        return res.json(usernames);
    } catch (error) {
        console.error('Admin Users Error:', error.message);
        return res.status(500).json({ error: "Server error" });
    }
});

// The signed-in user's own account details, shown read-only in the profile dialog.
router.get('/profile', jwtMiddleware, async (req, res) => {
    try {
        const username = String(req.user.username);
        const row = await User.findOne((user) => user.username === username);
        const groups = Array.isArray(row?.groups) ? row.groups : [];
        let signInMethod = 'Directory account';
        if (req.user.sso) signInMethod = 'Single sign-on';
        else if (groups.includes('local-admin')) signInMethod = 'Local account';
        return res.json({
            username,
            displayName: row?.displayName || req.user.displayName || username,
            email: row?.email || '',
            groups,
            isAdmin: Boolean(req.user.isAdmin),
            pingerAccess: Boolean(req.user.isAdmin || req.user.pingerAccess),
            signInMethod,
        });
    } catch (error) {
        console.error('Profile Error:', error.message);
        return res.status(500).json({ error: "Server error" });
    }
});

// Existing Routes with JWT Protection
router.get('/users', jwtMiddleware, isAdminMiddleware, async (req, res) => {
    try {
        const users = await User.all();
        res.json(users);
    } catch (error) {
        console.error('Users Error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

router.delete('/users/:username', jwtMiddleware, isAdminMiddleware, async (req, res) => {
    const { username } = req.params;
    try {
        const deletedUser = await User.deleteOne((user) => user.username === username);
        
        if (!deletedUser) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete User Error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

router.put('/grant-admin/:username', jwtMiddleware, isAdminMiddleware, async (req, res) => {
    const { username } = req.params;
    try {
        let user = await User.findOne((record) => record.username === username);
        
        if (!user) {
            user = await User.insert({
                username: username,
                displayName: `User ${username}`,
                email: placeholderEmailForUsername(username),
                isAdmin: true,
                groups: [],
            });
        } else {
            user = await User.updateById(user._id, { isAdmin: true });
        }
        
        res.json({
            message: `Admin privileges granted to ${username}`,
            user
        });
    } catch (error) {
        console.error('Grant Admin Error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;