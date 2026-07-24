const http = require('http');
const express = require("express");
require('dotenv').config();
require('./config/envDefaults').applyEnvDefaults();
const cors = require("cors");
const helmet = require('helmet');
const path = require('path');
const { DATA_DIR, UPLOADS_DIR, ensureDataDir } = require('./repositories/jsonStore');
const {
  loadDeploymentFromDatabaseIntoEnv,
  logEffectiveConfigurationAtStartup,
  applyTrustProxyToExpress,
} = require('./config/deploymentConfig');
const { upgradeAppSettingsIfNeeded } = require('./services/appSettingsUpgrade');
const serveChatFile = require('./middlewares/serveChatFile');

const app = express();

const serveStaticFrontend = process.env.SERVE_STATIC_FRONTEND !== 'false';

const PORT = process.env.PORT || 80;

function shutdown(signal, server, sshWss) {
  console.log(`Received ${signal}, closing HTTP server…`);
  if (sshWss && typeof sshWss.close === 'function') {
    try {
      sshWss.close();
    } catch (_) {
      /* ignore */
    }
  }
  if (!server) {
    process.exit(0);
    return;
  }
  server.close((err) => {
    if (err) console.error(err);
    process.exit(err ? 1 : 0);
  });
  // Docker / orchestrators send SIGTERM; don't wait forever if close stalls
  setTimeout(() => process.exit(0), 3000).unref();
}

function logStartupSummary() {
  const jwtExpRaw = process.env.JWT_EXPIRES_IN;
  const jwtExpDisp =
    jwtExpRaw !== undefined &&
    jwtExpRaw !== null &&
    String(jwtExpRaw).trim() !== '' &&
    !['0', 'false', 'none', 'never', 'off'].includes(String(jwtExpRaw).trim().toLowerCase())
      ? String(jwtExpRaw).trim()
      : 'never (until logout or JWT_SECRET rotates)';
  console.log(`JWT session TTL: ${jwtExpDisp}`);
  // Keycloak SSO startup summary
  const kcEnabled = String(process.env.KEYCLOAK_ENABLED || '').toLowerCase() === 'true';
  if (kcEnabled) {
    const kcUrl    = process.env.KEYCLOAK_URL    || '(unset)';
    const kcRealm  = process.env.KEYCLOAK_REALM  || '(unset)';
    const kcClient = process.env.KEYCLOAK_CLIENT_ID || '(unset)';
    const kcSecret = process.env.KEYCLOAK_CLIENT_SECRET ? '(set)' : '(unset)';
    const kcInsecure = process.env.KEYCLOAK_TLS_INSECURE || 'false';
    const kcRedirect = process.env.KEYCLOAK_REDIRECT_URI || '(auto-detect from Host header)';
    const kcIdpHint  = (process.env.KEYCLOAK_IDP_HINT || '').trim() || '(not set)';
    const kcPrompt   = (process.env.KEYCLOAK_PROMPT || '').trim() || '(not set — normal auth incl. Kerberos)';
    console.log('[keycloak-sso] SSO ENABLED (OIDC Authorization Code flow)');
    console.log(`[keycloak-sso]   URL:           ${kcUrl}`);
    console.log(`[keycloak-sso]   Realm:         ${kcRealm}`);
    console.log(`[keycloak-sso]   Client ID:     ${kcClient}`);
    console.log(`[keycloak-sso]   Client Secret: ${kcSecret}`);
    console.log(`[keycloak-sso]   Redirect URI:  ${kcRedirect}`);
    console.log(`[keycloak-sso]   IDP hint:      ${kcIdpHint}`);
    console.log(`[keycloak-sso]   Prompt:        ${kcPrompt}`);
    console.log(`[keycloak-sso]   TLS insecure:  ${kcInsecure}`);
    console.log(
      `[keycloak-sso]   Pause after logout: ${process.env.KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS || '10000'}ms auto-SSO delay (0 disables)`,
    );
    console.log(`[keycloak-sso]   Login:         GET /api/auth/sso/login`);
    console.log(`[keycloak-sso]   Callback:      GET /api/auth/sso/callback`);
  } else {
    console.log('[keycloak-sso] SSO disabled (set KEYCLOAK_ENABLED=true to activate)');
  }
}

async function start() {
  await ensureDataDir();
  console.log(`Using JSON data directory: ${DATA_DIR}`);
  await upgradeAppSettingsIfNeeded();
  const appSettingsRow = await loadDeploymentFromDatabaseIntoEnv();
  logEffectiveConfigurationAtStartup(appSettingsRow);
  applyTrustProxyToExpress(app);

  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(express.json());

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });
  app.get('/api/uploads/files/chat/:filename', (req, res) => {
    serveChatFile(req, res);
  });
  app.use('/api/uploads/files', express.static(UPLOADS_DIR));

  // Routes (and LDAP init) load after deployment settings are applied to process.env
  const router = require("./routes");
  app.use("/api", router);

  if (serveStaticFrontend) {
    const buildDir = path.join(__dirname, '../frontend/build');
    // Many clients still request /favicon.ico; serve the same asset as index.html’s icon (avoids stale bundled .ico).
    app.get('/favicon.ico', (_req, res) => {
      res.type('image/png');
      res.sendFile(path.join(buildDir, 'logo192.png'));
    });
    app.use(express.static(buildDir));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, '../frontend/build', 'index.html'));
    });
  }

  logStartupSummary();

  const attachPingerSshWebSocket = require('./services/pingerSshWebSocket');
  const httpServer = http.createServer(app);
  const sshWss = attachPingerSshWebSocket(httpServer);

  const server = httpServer.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
  });
  process.on('SIGINT', () => shutdown('SIGINT', server, sshWss));
  process.on('SIGTERM', () => shutdown('SIGTERM', server, sshWss));
}

start().catch((err) => {
  console.error("Failed to start server");
  console.error(err);
  process.exit(1);
});
