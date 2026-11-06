const ActiveDirectory = require('activedirectory2').promiseWrapper;
const ldap = require('ldapjs');

class ActiveDirectoryService {
    _activeDirectory = null;
    client = null;

    /** The directory is optional. Without it, sign-in works through the local admin or SSO only. */
    isConfigured() {
        return this._activeDirectory !== null;
    }

    initActiveDirectory() {
        this._activeDirectory = null;
        this.client = null;
        if (!(process.env.LDAP_URL || '').trim()) {
            console.log('[ldap] LDAP_URL is not set, so directory sign-in is off.');
            return;
        }
        try {
            this.connect();
        } catch (err) {
            // A bad address in the settings must not stop the whole app from starting.
            this._activeDirectory = null;
            this.client = null;
            console.error(`[ldap] Directory sign-in is off, because the settings are not valid: ${err.message}`);
        }
    }

    connect() {
        const config = {
            url: process.env.LDAP_URL,
            baseDN: process.env.LDAP_SEARCH_BASE,
            username: process.env.LDAP_ADMIN,
            password: process.env.LDAP_PASSWORD,
        };
        this._activeDirectory = new ActiveDirectory(config);
        this.clientCreate();
    }

    clientCreate() {
        this.client = ldap.createClient({
            url: process.env.LDAP_URL,
            reconnect: true,
        });
        this.client.on('error', (err) => {
            console.log(err);
        });
        this.client.on('connect', () => {
            this.clientBind();
        });
    }

    async clientBind() {
        return new Promise((resolve, reject) => {
            this.client.bind(process.env.LDAP_ADMIN, process.env.LDAP_PASSWORD, (err) => {
                if (err) {
                    console.log(err);
                    reject();
                }
                resolve();
            });
        });
    }

    async clientUnbind() {
        return new Promise((resolve, reject) => {
            this.client.unbind(err => {
                if (err) {
                    console.log(err);
                    reject();
                } else {
                    resolve();
                }
            });
        });
    }

    async authenticate(username, password) {
        if (!this.isConfigured()) return false;
        try {
            await this._activeDirectory.authenticate(username, password);
            return true;
        } catch (err) {
            console.log(err.message);
            return false;
        }
    }

    async findUserByName(username) {
        if (!this.isConfigured()) return null;
        try {
            let user = await this._activeDirectory.findUser(username);
            if (!user) {
                return null;
            }
            return user;
        } catch (err) {
            console.log(err.message);
            throw new Error(`ERROR: ${JSON.stringify(err)}`);
        }
    }

    async findUsers(filter) {
        if (!this.isConfigured()) return [];
        try {
            let users = await this._activeDirectory.findUsers(filter);
            return users || []; // Always return an array
        } catch (err) {
            console.error(`LDAP Error: ${err.message}`);
            throw new Error(`LDAP Search Error: ${err.message}`);
        }
    }

    async findUserGroups(username) {
        if (!this.isConfigured()) return [];
        try {
            let groups = await this._activeDirectory.getGroupMembershipForUser(username);
            if (!groups) {
                throw new Error(`User ${username} not found.`);
            }
            return groups;
        } catch (err) {
            console.log(err.message);
            throw new Error(`ERROR: ${err}`);
        }
    }

    /**
     * Prefer DN / UPN / sAM — group lookup is picky about identifier format.
     */
    async findUserGroupsForAdUser(adUser) {
        if (!adUser || !this.isConfigured()) {
            return [];
        }
        const ids = [
            adUser.distinguishedName,
            adUser.userPrincipalName,
            adUser.sAMAccountName,
        ].filter(Boolean);
        let lastErr;
        for (let i = 0; i < ids.length; i += 1) {
            try {
                const groups = await this._activeDirectory.getGroupMembershipForUser(ids[i]);
                if (groups) return groups;
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) {
            console.log('findUserGroupsForAdUser:', lastErr.message);
        }
        return [];
    }

    /** Try to load AD user after a successful bind (any candidate format). */
    async findAdUserByAnyCandidate(candidates) {
        const list = Array.isArray(candidates) ? [...new Set(candidates.filter(Boolean))] : [];
        for (let i = 0; i < list.length; i += 1) {
            try {
                const u = await this.findUserByName(list[i]);
                if (u && (u.sAMAccountName || u.userPrincipalName)) {
                    return u;
                }
            } catch (err) {
                console.log('findUser:', list[i], err.message);
            }
        }
        return null;
    }

    async findGroupByName(groupName) {
        if (!this.isConfigured()) return null;
        try {
            let group = await this._activeDirectory.findGroup(groupName);
            if (!group) {
                return null;
            }
            return group;
        } catch (err) {
            console.log(err.message);
            throw new Error(`ERROR: ${JSON.stringify(err)}`);
        }
    }

    /**
     * Recreate AD client and ldapjs client from current process.env (after deployment settings change).
     */
    reinitialize() {
        try {
            if (this.client && typeof this.client.unbind === 'function') {
                this.client.unbind(() => {});
            }
        } catch (e) {
            /* ignore */
        }
        this.initActiveDirectory();
    }
}

module.exports = ActiveDirectoryService;