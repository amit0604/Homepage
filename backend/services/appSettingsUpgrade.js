/**
 * Idempotent merges for legacy `settings.json` (`key: "app"`).
 * Runs once at startup before deployment overrides load into process.env.
 */
const { collections } = require('../repositories/jsonStore');
const { normalizeMotd, motdDocumentNeedsMerge } = require('./motdService');

const Settings = collections.settings;

function isPlainObject(o) {
  return o != null && typeof o === 'object' && !Array.isArray(o);
}

/**
 * @returns {Promise<{ changed: boolean, keys?: string[] }>}
 */
async function upgradeAppSettingsIfNeeded() {
  const row = await Settings.findOne((r) => r.key === 'app');
  if (!row) {
    return { changed: false };
  }

  /** @type {Record<string, unknown>} */
  const patch = {};

  const dep = row.deployment;
  if (!isPlainObject(dep)) {
    patch.deployment = {};
  }

  if (!Array.isArray(row.contacts)) {
    patch.contacts = [];
  }

  if (!Object.prototype.hasOwnProperty.call(row, 'lobbyChatEnabled')) {
    patch.lobbyChatEnabled = true;
  }

  if (motdDocumentNeedsMerge(row.motd)) {
    patch.motd = normalizeMotd(row.motd);
  }

  if (!Object.prototype.hasOwnProperty.call(row, 'pingerSshIdleTimeoutMinutes')) {
    patch.pingerSshIdleTimeoutMinutes = 5;
  }

  if (!Object.prototype.hasOwnProperty.call(row, 'pingerSshCommonCommands')) {
    patch.pingerSshCommonCommands = [];
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return { changed: false };
  }

  await Settings.updateById(row._id, patch);
  console.log(`[upgrade] settings.json (app): merged default fields — ${keys.join(', ')}`);
  return { changed: true, keys };
}

module.exports = {
  upgradeAppSettingsIfNeeded,
};
