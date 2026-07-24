/**
 * When false, lobby chat is hidden in the API and UI regardless of the admin setting.
 * Set via env, e.g. docker-compose: LOBBY_CHAT_UI=false
 */
function isLobbyChatUiEnabledByDeploy() {
  const v = process.env.LOBBY_CHAT_UI;
  if (v == null || v === '') {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') {
    return false;
  }
  return true;
}

module.exports = { isLobbyChatUiEnabledByDeploy };
