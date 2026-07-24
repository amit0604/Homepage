const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_COLLECTIONS = [
  'users',
  'tickets',
  'notifications',
  'servers',
  'departments',
  'settings',
  'shortcuts',
  'lobbyChat',
  'chatConversations',
  'chatMessages',
  'chatReads',
  'chatHiddenConversations',
  'chatPresence',
  'pingerHosts',
  'pingerSshHostKeys',
];

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const writeQueues = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

async function ensureDataDir(collections = DEFAULT_COLLECTIONS) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  await Promise.all(
    collections.map(async (collectionName) => {
      const filePath = getCollectionPath(collectionName);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, '[]\n', 'utf8');
      }
    })
  );
}

function getCollectionPath(collectionName) {
  return path.join(DATA_DIR, `${collectionName}.json`);
}

async function readCollection(collectionName) {
  await ensureDataDir([collectionName]);
  const filePath = getCollectionPath(collectionName);
  const raw = await fs.readFile(filePath, 'utf8');

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${collectionName}.json must contain a JSON array`);
  }

  return parsed;
}

async function writeCollection(collectionName, records) {
  await ensureDataDir([collectionName]);
  const filePath = getCollectionPath(collectionName);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(records, null, 2)}\n`;

  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, filePath);
}

function withCollectionLock(collectionName, operation) {
  const previous = writeQueues.get(collectionName) || Promise.resolve();
  const next = previous.then(operation, operation);
  writeQueues.set(
    collectionName,
    next.catch(() => {
      // Keep the chain alive after a failed write.
    })
  );
  return next;
}

function createCollection(collectionName) {
  return {
    async all() {
      return clone(await readCollection(collectionName));
    },

    async find(predicate = () => true) {
      const records = await readCollection(collectionName);
      return clone(records.filter(predicate));
    },

    async findOne(predicate) {
      const records = await readCollection(collectionName);
      const record = records.find(predicate);
      return record ? clone(record) : null;
    },

    async findById(id) {
      const sid = String(id);
      return this.findOne((record) => String(record._id) === sid);
    },

    async insert(record) {
      return withCollectionLock(collectionName, async () => {
        const records = await readCollection(collectionName);
        const nextRecord = {
          ...record,
          _id: record._id || createId(),
        };

        if (!nextRecord.createdAt) {
          nextRecord.createdAt = now();
        }

        records.push(nextRecord);
        await writeCollection(collectionName, records);
        return clone(nextRecord);
      });
    },

    async updateById(id, updates) {
      return withCollectionLock(collectionName, async () => {
        const records = await readCollection(collectionName);
        const sid = String(id);
        const index = records.findIndex((record) => String(record._id) === sid);

        if (index === -1) {
          return null;
        }

        const nextUpdates =
          typeof updates === 'function' ? updates(clone(records[index])) : updates;
        const cleanUpdates = Object.fromEntries(
          Object.entries(nextUpdates).filter(([, value]) => value !== undefined)
        );
        records[index] = {
          ...records[index],
          ...cleanUpdates,
          _id: records[index]._id,
        };

        await writeCollection(collectionName, records);
        return clone(records[index]);
      });
    },

    async deleteById(id) {
      return withCollectionLock(collectionName, async () => {
        const records = await readCollection(collectionName);
        const sid = String(id);
        const index = records.findIndex((record) => String(record._id) === sid);

        if (index === -1) {
          return null;
        }

        const [deleted] = records.splice(index, 1);
        await writeCollection(collectionName, records);
        return clone(deleted);
      });
    },

    /** Keep only records for which `predicate` returns true. Returns { removed, kept }. */
    async keepWhere(predicate) {
      return withCollectionLock(collectionName, async () => {
        const records = await readCollection(collectionName);
        const next = records.filter((r) => predicate(r));
        if (next.length === records.length) {
          return { removed: 0, kept: next.length };
        }
        await writeCollection(collectionName, next);
        return { removed: records.length - next.length, kept: next.length };
      });
    },

    async deleteOne(predicate) {
      return withCollectionLock(collectionName, async () => {
        const records = await readCollection(collectionName);
        const index = records.findIndex(predicate);

        if (index === -1) {
          return null;
        }

        const [deleted] = records.splice(index, 1);
        await writeCollection(collectionName, records);
        return clone(deleted);
      });
    },
  };
}

const pingerHostsBase = createCollection('pingerHosts');

/** Single write: avoids lost updates when many sequential updateById run under load. */
async function pingerHostsReorderByIds(orderedIds) {
  return withCollectionLock('pingerHosts', async () => {
    const records = await readCollection('pingerHosts');
    const normalized = orderedIds.map((raw) => String(raw).trim());
    const byId = new Map(records.map((r) => [String(r._id), r]));
    if (normalized.length !== records.length) {
      throw new Error('ids must list each host exactly once');
    }
    const seen = new Set();
    for (let i = 0; i < normalized.length; i += 1) {
      const id = normalized[i];
      if (!byId.has(id)) {
        throw new Error('Host not found');
      }
      if (seen.has(id)) {
        throw new Error('duplicate id');
      }
      seen.add(id);
    }
    const next = normalized.map((id, i) => ({
      ...byId.get(id),
      sortOrder: i,
    }));
    await writeCollection('pingerHosts', next);
    return clone(next);
  });
}

/** Persist first transition to down (lastDownSince); clear when back up. Call only after fresh probe. */
async function pingerHostsSyncDownTimestamps(probeRows) {
  return withCollectionLock('pingerHosts', async () => {
    const records = await readCollection('pingerHosts');
    const byProbe = new Map(probeRows.map((r) => [String(r._id), r]));
    let changed = false;
    const next = records.map((row) => {
      const pr = byProbe.get(String(row._id));
      if (!pr) return row;
      const copy = { ...row };
      if (pr.state === 'down' && !copy.lastDownSince) {
        copy.lastDownSince = new Date().toISOString();
        changed = true;
      } else if (pr.state !== 'down' && copy.lastDownSince) {
        copy.lastDownSince = null;
        changed = true;
      }
      return copy;
    });
    if (changed) {
      await writeCollection('pingerHosts', next);
    }
    return clone(next);
  });
}

async function loadAllCollectionsSnapshot() {
  await ensureDataDir();
  const out = {};
  for (let i = 0; i < DEFAULT_COLLECTIONS.length; i += 1) {
    const name = DEFAULT_COLLECTIONS[i];
    out[name] = clone(await readCollection(name));
  }
  return out;
}

/**
 * Replaces every collection file under DATA_DIR. Keys missing from snapshot become [].
 * Unknown keys in snapshot are ignored.
 */
async function replaceAllCollectionsFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Snapshot must be an object');
  }
  await ensureDataDir();
  for (let i = 0; i < DEFAULT_COLLECTIONS.length; i += 1) {
    const name = DEFAULT_COLLECTIONS[i];
    const data = snapshot[name];
    if (data !== undefined && !Array.isArray(data)) {
      throw new Error(`Collection "${name}" must be an array`);
    }
    const rows = data !== undefined ? data : [];
    await writeCollection(name, clone(rows));
  }
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  DEFAULT_COLLECTIONS,
  ensureDataDir,
  loadAllCollectionsSnapshot,
  replaceAllCollectionsFromSnapshot,
  collections: {
    users: createCollection('users'),
    tickets: createCollection('tickets'),
    notifications: createCollection('notifications'),
    servers: createCollection('servers'),
    departments: createCollection('departments'),
    settings: createCollection('settings'),
    shortcuts: createCollection('shortcuts'),
    lobbyChat: createCollection('lobbyChat'),
    chatConversations: createCollection('chatConversations'),
    chatMessages: createCollection('chatMessages'),
    chatReads: createCollection('chatReads'),
    chatHiddenConversations: createCollection('chatHiddenConversations'),
    chatPresence: createCollection('chatPresence'),
    pingerHosts: {
      ...pingerHostsBase,
      reorderByIds: pingerHostsReorderByIds,
      syncDownTimestamps: pingerHostsSyncDownTimestamps,
    },
    pingerSshHostKeys: createCollection('pingerSshHostKeys'),
  },
};
