/**
 * When false, Checkmk admin UI and API are off regardless of CHECKMK_* credentials.
 * Set via env, e.g. docker-compose: CHECKMK_UI=false
 */
function isCheckmkUiEnabledByDeploy() {
  const v = process.env.CHECKMK_UI;
  if (v == null || v === '') {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') {
    return false;
  }
  return true;
}

module.exports = { isCheckmkUiEnabledByDeploy };
