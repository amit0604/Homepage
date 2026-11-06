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

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason && reason.message ? reason.message : reason);
});

async function start() {
  await ensureDataDir();
  console.log(`Using JSON data directory: ${DATA_DIR}`);
  await upgradeAppSettingsIfNeeded();
  const appSettingsRow = await loadDeploymentFromDatabaseIntoEnv();
  await require('./utils/ensureJwtSecret').ensureJwtSecret(DATA_DIR);
  logEffectiveConfigurationAtStartup(appSettingsRow);
  applyTrustProxyToExpress(app);

  const corsOrigin = process.env.CORS_ORIGIN;
  // Other websites may only call this API when CORS_ORIGIN names them.
  if (corsOrigin) app.use(cors({ origin: corsOrigin }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'http:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
    }),
  );
  // The sign-in hand-off pages are small inline scripts with no outside content.
  app.use('/api/auth/sso', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    next();
  });
  app.use(express.json());

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });
  app.get('/api/uploads/files/chat/:filename', (req, res) => {
    serveChatFile(req, res);
  });
  app.use('/api/uploads/files', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Chat files are only served by the checked route above, however the address is written.
    let rel;
    try {
      rel = path.posix.normalize(decodeURIComponent(req.path)).replace(/^\/+/, '').toLowerCase();
    } catch {
      return res.status(400).json({ message: 'Invalid path' });
    }
    if (rel === 'chat' || rel.startsWith('chat/')) {
      return res.status(404).json({ message: 'Not found' });
    }
    return next();
  }, express.static(UPLOADS_DIR));

  // Routes (and LDAP init) load after deployment settings are applied to process.env
  const router = require("./routes");
  app.use("/api", router);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[api-error]', err.message);
    res.status(status).json({ error: status >= 500 ? 'Server error' : 'The request could not be processed' });
  });

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

  require('./services/chatBridge').startChatBridge();

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
