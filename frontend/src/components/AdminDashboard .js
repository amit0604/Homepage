import React, { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react';
import { jwtDecode } from 'jwt-decode';
import { isJwtExpired } from '../utils/jwtSession';
import {
  PHONE_KIND_MOBILE,
  PHONE_KIND_INTERNAL,
  displayPhoneFromTicket,
  formStateFromTicket,
  isPhoneFormValid,
  buildPhoneApiBody,
} from '../utils/ticketPhone';
import {
  formatCreatorTableCell,
  formatCreatorPreviewLine,
  formatCreatorTooltip,
} from '../utils/ticketUserDisplay';
import { uploadAdminImage } from '../utils/uploadAdminImage';

/**
 * Colored toggle for admin settings (replaces bare checkboxes).
 * Uses a visually hidden checkbox + styled track for accessibility.
 */
function AdminSettingsToggle({
  id,
  checked,
  onChange,
  disabled,
  children,
  className,
}) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <label
      className={`admin-settings-toggle ${className || ''}${disabled ? ' admin-settings-toggle--disabled' : ''}`}
      htmlFor={inputId}
    >
      <input
        id={inputId}
        type="checkbox"
        className="admin-settings-toggle__input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
      />
      <span className="admin-settings-toggle__track" aria-hidden="true">
        <span className="admin-settings-toggle__thumb" />
      </span>
      {children ? <span className="admin-settings-toggle__text">{children}</span> : null}
    </label>
  );
}

/** Asterisk for required settings fields (paired with footer legend below cards). */
function AdminRequiredStar() {
  return (
    <abbr className="admin-field-required-star" title="Required">
      *
    </abbr>
  );
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    return cells;
  });
}

function mapTicketImportRows(matrix) {
  if (matrix.length < 2) return [];
  const headers = matrix[0].map((h) =>
    String(h).trim().replace(/^\uFEFF/, '').toLowerCase(),
  );
  const idx = (name) => headers.indexOf(name);
  const pick = (row, ...names) => {
    for (let n = 0; n < names.length; n += 1) {
      const i = idx(names[n]);
      if (i >= 0 && row[i] !== undefined && String(row[i]).trim() !== '') return row[i];
    }
    return '';
  };
  return matrix.slice(1)
    .filter((row) => row.some((cell) => String(cell || '').trim() !== ''))
    .map((row) => ({
    title: pick(row, 'title', 'subject', 'summary', 'request'),
    description: pick(row, 'description', 'desc', 'details', 'body'),
    status: pick(row, 'status', 'state'),
    department: pick(row, 'department', 'dept', 'unit'),
    phoneNumber: pick(row, 'phone number', 'phonenumber', 'phone', 'mobile', 'tel'),
    assignedTo: pick(row, 'assigned to', 'assignedto', 'assigned', 'assignee', 'owner'),
    createdBy: pick(
      row,
      'created by',
      'createdby',
      'creator',
      'requester',
      'submitted by',
      'user',
      'userid',
      'user id',
      'username',
      'email',
    ),
    createdAt: pick(row, 'created at', 'createdat', 'date', 'submitted', 'opened'),
  }));
}

function normSam(u) {
  if (u == null) return '';
  const s = String(u).trim().toLowerCase();
  const i = s.indexOf('@');
  return i >= 0 ? s.slice(0, i) : s;
}

function mapShortcutImportRows(matrix) {
  if (matrix.length < 2) return [];
  const headers = matrix[0].map((h) =>
    String(h).trim().replace(/^\uFEFF/, '').toLowerCase(),
  );
  const idx = (name) => headers.indexOf(name);
  const pick = (row, ...names) => {
    for (let n = 0; n < names.length; n += 1) {
      const i = idx(names[n]);
      if (i >= 0 && row[i] !== undefined && String(row[i]).trim() !== '') return row[i];
    }
    return '';
  };
  return matrix
    .slice(1)
    .filter((row) => row.some((cell) => String(cell || '').trim() !== ''))
    .map((row) => ({
      title: pick(row, 'title'),
      url: pick(row, 'url', 'link'),
      description: pick(row, 'description', 'desc'),
      category: pick(row, 'category'),
      imgSrc: pick(row, 'imgsrc', 'img src', 'image', 'image url', 'img'),
      alt: pick(row, 'alt'),
      sortOrder: pick(row, 'sortorder', 'sort order', 'sort'),
      adminOnly: pick(row, 'admin only', 'adminonly', 'admins only'),
    }));
}

function adminTicketStatusClass(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'pending') return 'admin-status-pill--pending';
  if (s === 'in progress') return 'admin-status-pill--in-progress';
  if (s === 'closed') return 'admin-status-pill--closed';
  return 'admin-status-pill--default';
}

async function downloadAdminChatAttachment(ev, a) {
  ev.preventDefault();
  try {
    const token = localStorage.getItem('token');
    if (!token) return;
    const r = await fetch(a.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const blob = await r.blob();
    const u = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = u;
    link.download = (a.name && String(a.name).slice(0, 180)) || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(u);
  } catch {
    /* ignore */
  }
}

const DEPLOYMENT_SECTION_ORDER = [
  'chat',
  'ldap',
  'localAdmin',
  'keycloak',
  'checkmk',
  'pinger',
  'advanced',
];

const DEPLOYMENT_SECTION_TITLES = {
  chat: 'Chat & retention',
  ldap: 'LDAP / Active Directory & login',
  localAdmin: 'Local admin account',
  keycloak: 'Keycloak SSO',
  checkmk: 'Checkmk integration',
  pinger: 'Pinger',
  advanced: 'Advanced (JWT TTL, CORS)',
};

/** Short intros under each deployment card header (match MOTD-style guidance). */
const DEPLOYMENT_SECTION_INTRO = {
  chat:
    'Homepage Chat tab, message retention, and garbage collection. Force-hide Chat from the server with LOBBY_CHAT_UI in Docker / compose (see toggle note). Keep GC at least one minute.',
  ldap:
    'Directory sign-in (bind URL, search base, groups) and login identity: default email/domain used when the app derives a user identity from LDAP.',
  localAdmin:
    'Fallback admin user when LDAP is unavailable. Username and password follow Docker/host environment when those variables are set at startup.',
  keycloak:
    'OpenID Connect SSO. In Keycloak, open your client and set Valid redirect URIs to match how users reach this app (see the Redirect URI field below). With a reverse proxy, use TRUST_PROXY=1 so the app can build the callback URL from X-Forwarded headers when this field is left blank.',
  checkmk:
    'Embeds Checkmk widgets and APIs. Secrets are masked after save; leave password fields blank to keep the current value.',
  pinger:
    'Ping warn threshold, probe cache, in-browser SSH idle timeout, and saved CLI snippets per host type.',
  advanced:
    'Trust proxy for correct client IP and URL behind ingress; JWT bearer lifetime; optional CORS origin allowlist.',
};

/**
 * Logical groups for the LDAP section only (same keys as merged `ldap` block from API).
 */
const LDAP_FIELD_GROUPS = [
  {
    title: 'Server & bind',
    keys: ['LDAP_URL', 'LDAP_SEARCH_BASE', 'LDAP_ADMIN', 'LDAP_PASSWORD'],
  },
  {
    title: 'Groups & domain',
    keys: ['LDAP_ADMIN_GROUP_DN', 'LDAP_PINGER_GROUP_DN', 'LDAP_NETBIOS_DOMAIN'],
  },
  {
    title: 'Display-name lookup',
    keys: ['LDAP_DISPLAY_NAME_LOOKUP', 'LDAP_LOOKUP_TIMEOUT_MS', 'LDAP_DISPLAY_NAME_PAUSE_SEC'],
  },
  {
    title: 'Login identity',
    keys: ['USER_EMAIL_DOMAIN'],
  },
];

const LDAP_GROUP_KEY_ORDER = LDAP_FIELD_GROUPS.flatMap((g) => g.keys);

const DEPLOYMENT_BOOLEAN_KEYS = new Set([
  'LOBBY_CHAT_UI',
  'TRUST_PROXY',
  'KEYCLOAK_ENABLED',
  'KEYCLOAK_TLS_INSECURE',
  'CHECKMK_UI',
  'LDAP_DISPLAY_NAME_LOOKUP',
]);

const DEPLOYMENT_SECRET_KEYS = new Set([
  'LDAP_PASSWORD',
  'CHECKMK_AUTOMATION_SECRET',
  'KEYCLOAK_CLIENT_SECRET',
  'LOCAL_ADMIN_PASSWORD',
]);

/** Human-readable labels for deployment env keys (title-style). */
function prettyDeploymentLabel(key) {
  return String(key)
    .split('_')
    .map((part) => {
      const upper = part.toUpperCase();
      const acronyms = [
        ['LDAP', 'LDAP'],
        ['URL', 'URL'],
        ['UI', 'UI'],
        ['JWT', 'JWT'],
        ['CORS', 'CORS'],
        ['TTL', 'TTL'],
        ['SSO', 'SSO'],
        ['TLS', 'TLS'],
        ['API', 'API'],
        ['IDP', 'IdP'],
        ['DN', 'DN'],
        ['MS', 'ms'],
        ['GC', 'GC'],
      ];
      for (let i = 0; i < acronyms.length; i += 1) {
        if (acronyms[i][0] === upper) return acronyms[i][1];
      }
      return part.charAt(0) + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function deploymentFieldKeysForSection(sectionId, block) {
  if (!block) return [];
  const keys = Object.keys(block);
  if (sectionId !== 'ldap') return keys;
  const set = new Set(keys);
  const ordered = LDAP_GROUP_KEY_ORDER.filter((k) => set.has(k));
  const rest = keys.filter((k) => !LDAP_GROUP_KEY_ORDER.includes(k));
  return [...ordered, ...rest.sort()];
}

function deploymentSettingsFieldIsRequired(sectionId, fieldKey, sectionBlock) {
  if (!sectionBlock || typeof sectionBlock !== 'object') return false;
  if (DEPLOYMENT_BOOLEAN_KEYS.has(fieldKey)) return false;

  const ldapCore = ['LDAP_URL', 'LDAP_SEARCH_BASE', 'LDAP_ADMIN', 'LDAP_PASSWORD'];
  if (sectionId === 'ldap' && ldapCore.includes(fieldKey)) return true;

  const localCore = ['LOCAL_ADMIN_USERNAME', 'LOCAL_ADMIN_PASSWORD'];
  if (sectionId === 'localAdmin' && localCore.includes(fieldKey)) return true;

  const ckCore = ['CHECKMK_BASE_URL', 'CHECKMK_AUTOMATION_USER', 'CHECKMK_AUTOMATION_SECRET'];
  if (sectionId === 'checkmk' && ckCore.includes(fieldKey)) return true;

  if (sectionId === 'keycloak' && sectionBlock.KEYCLOAK_ENABLED) {
    const kcReq = [
      'KEYCLOAK_URL',
      'KEYCLOAK_REALM',
      'KEYCLOAK_CLIENT_ID',
      'KEYCLOAK_CLIENT_SECRET',
    ];
    return kcReq.includes(fieldKey);
  }

  return false;
}

const DEPLOYMENT_FIELD_PLACEHOLDER = {
  KEYCLOAK_REDIRECT_URI:
    'Leave blank to auto-detect behind a proxy, or https://your-public-host/api/auth/sso/callback',
  KEYCLOAK_POST_LOGOUT_REDIRECT_URI:
    'Leave blank for https://same-host/api/auth/sso/post-logout',
};

function DeploymentTrustProxyHelp({ fieldKey }) {
  if (fieldKey !== 'TRUST_PROXY') return null;
  return (
    <div className="admin-help-text small mt-2 mb-0">
      <p className="mb-0">
        Turn <strong>on</strong> when this app sits behind a reverse proxy or ingress so Express trusts{' '}
        <code>X-Forwarded-For</code>, <code>X-Forwarded-Proto</code>, and <code>X-Forwarded-Host</code> (rate limiting,
        OAuth redirect URLs, and URLs derived from the request use the public hostname). Turn <strong>off</strong> for a
        direct container or host binding with no proxy. Like other deployment fields, a value saved here overrides{' '}
        <code>TRUST_PROXY</code> from Docker Compose for this process; remove it from saved deployment settings to fall back
        to the container environment again.
      </p>
    </div>
  );
}

function DeploymentKeycloakUriHelp({ fieldKey }) {
  if (fieldKey === 'KEYCLOAK_REDIRECT_URI') {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const suggested = origin ? `${origin}/api/auth/sso/callback` : '';
    return (
      <div className="admin-help-text small mt-2 mb-0">
        <p className="mb-2">
          <strong>What to put here:</strong> the exact URL Keycloak is allowed to redirect the browser to after login.
          It must appear in the Keycloak client under <strong>Valid redirect URIs</strong> (exact match or a pattern your
          realm allows). Path is always <code className="text-nowrap">/api/auth/sso/callback</code>.
        </p>
        <p className="mb-2">
          Format: <code className="text-break">https://your-public-hostname/api/auth/sso/callback (the homepage host name)</code> — use the same
          scheme and host that users use in the address bar (after any reverse proxy / ingress).
        </p>
        <p className="mb-2">
          <strong>Leave blank</strong> when the app can infer the public URL from each request: set{' '}
          <code className="text-nowrap">TRUST_PROXY=1</code> on the server and ensure your proxy forwards{' '}
          <code>X-Forwarded-Host</code> / <code>X-Forwarded-Proto</code> (or equivalent). The server then builds the
          redirect URI that Keycloak must still whitelist for that host.
        </p>
        {suggested ? (
          <p className="mb-0">
            <strong>If this admin page is opened on the same URL users use:</strong>{' '}
            <code className="text-break user-select-all">{suggested}</code>
          </p>
        ) : null}
      </div>
    );
  }
  if (fieldKey === 'KEYCLOAK_POST_LOGOUT_REDIRECT_URI') {
    return (
      <div className="admin-help-text small mt-2 mb-0">
        <p className="mb-0">
          Where Keycloak may redirect after sign-out. Add the same URL under <strong>Valid post logout redirect URIs</strong>{' '}
          for this client. If blank, the app uses{' '}
          <code className="text-break">…/api/auth/sso/post-logout</code> on the same host as the login redirect.
        </p>
      </div>
    );
  }
  return null;
}

function DeploymentEnvFieldRow({ sectionId, fieldKey, value, setDeploymentSections, sectionBlock }) {
  const secret = DEPLOYMENT_SECRET_KEYS.has(fieldKey);
  const bool = DEPLOYMENT_BOOLEAN_KEYS.has(fieldKey);
  const controlId = `deploy-field-${sectionId}-${fieldKey}`;
  const title = prettyDeploymentLabel(fieldKey);
  const showRequired = deploymentSettingsFieldIsRequired(sectionId, fieldKey, sectionBlock);

  return (
    <div className="admin-settings-field-row">
      <div className="admin-settings-field-row__label-wrap">
        {bool ? (
          <span className="admin-settings-field-row__label">
            {title}
            {showRequired ? <AdminRequiredStar /> : null}
            <span className="admin-settings-field-row__docker-env">{fieldKey}</span>
          </span>
        ) : (
          <label className="admin-settings-field-row__label" htmlFor={controlId}>
            {title}
            {showRequired ? <AdminRequiredStar /> : null}
            <span className="admin-settings-field-row__docker-env">{fieldKey}</span>
          </label>
        )}
      </div>
      <div className="admin-settings-field-row__control">
        {bool ? (
          <AdminSettingsToggle
            id={`deploy-switch-${sectionId}-${fieldKey}`}
            checked={!!value}
            onChange={(v) => {
              setDeploymentSections((prev) => {
                if (!prev || !prev[sectionId]) return prev;
                return {
                  ...prev,
                  [sectionId]: { ...prev[sectionId], [fieldKey]: v },
                };
              });
            }}
          >
            <span className="small text-muted">
              {fieldKey === 'TRUST_PROXY' ? 'Trust reverse-proxy headers (X-Forwarded-*)' : 'Enabled'}
            </span>
          </AdminSettingsToggle>
        ) : (
          <input
            id={controlId}
            type={secret ? 'password' : 'text'}
            className="form-control"
            autoComplete="off"
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={
              secret ? 'Leave blank to keep current' : DEPLOYMENT_FIELD_PLACEHOLDER[fieldKey] || ''
            }
            aria-label={title}
            onChange={(e) => {
              setDeploymentSections((prev) => {
                if (!prev || !prev[sectionId]) return prev;
                return {
                  ...prev,
                  [sectionId]: {
                    ...prev[sectionId],
                    [fieldKey]: e.target.value,
                  },
                };
              });
            }}
          />
        )}
        <DeploymentKeycloakUriHelp fieldKey={fieldKey} />
        <DeploymentTrustProxyHelp fieldKey={fieldKey} />
      </div>
    </div>
  );
}

function normalizeDeploymentFieldValue(key, raw) {
  if (DEPLOYMENT_BOOLEAN_KEYS.has(key)) {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return raw ?? '';
}

function coerceDeploymentOutgoingValue(key, raw) {
  if (DEPLOYMENT_BOOLEAN_KEYS.has(key)) {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  const isNumKey =
    key.endsWith('_MS') ||
    key.endsWith('_SEC') ||
    key === 'CHAT_RETENTION_DAYS' ||
    key === 'CHAT_GC_INTERVAL_MS' ||
    key === 'PINGER_WARN_MS' ||
    key === 'PINGER_CACHE_MS';
  if (isNumKey) {
    if (raw === '' || raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (raw === '' || raw === undefined || raw === null) return null;
  return String(raw);
}

function adminContactRowKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cnt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Rows with client-only `_rowKey` so inputs stay aligned when reordering. */
function normalizeAdminContactRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    name: c && c.name != null ? String(c.name) : '',
    phone: c && c.phone != null ? String(c.phone) : '',
    title: c && c.title != null ? String(c.title) : '',
    _rowKey: adminContactRowKey(),
  }));
}

function adminContactsPayload(rows) {
  return rows.map((r) => ({
    name: String(r?.name ?? '').trim(),
    phone: String(r?.phone ?? '').trim(),
    title: String(r?.title ?? '').trim(),
  }));
}

function pingerSshCmdRowKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ssh-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** API list → grouped sections for the admin UI (one card per host type). */
function pingerSshCommandsApiToSections(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const byKey = new Map();
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const dt = r && r.deviceType != null ? String(r.deviceType).trim() : '';
    const key = dt ? dt.toLowerCase() : '__all__';
    if (!byKey.has(key)) {
      byKey.set(key, { deviceType: dt, commands: [] });
    }
    const bucket = byKey.get(key);
    if (dt && !bucket.deviceType) bucket.deviceType = dt;
    bucket.commands.push({
      _rowKey: pingerSshCmdRowKey(),
      label: r && r.label != null ? String(r.label) : '',
      command: r && r.command != null ? String(r.command) : '',
    });
  }
  const sections = [];
  if (byKey.has('__all__')) {
    const b = byKey.get('__all__');
    sections.push({
      _sectionKey: pingerSshCmdRowKey(),
      deviceType: '',
      commands: b.commands,
    });
    byKey.delete('__all__');
  }
  const restKeys = [...byKey.keys()].sort();
  for (let j = 0; j < restKeys.length; j += 1) {
    const b = byKey.get(restKeys[j]);
    sections.push({
      _sectionKey: pingerSshCmdRowKey(),
      deviceType: b.deviceType,
      commands: b.commands,
    });
  }
  return sections;
}

function pingerSshSectionsToApiPayload(sections) {
  const flat = [];
  if (!Array.isArray(sections)) return flat;
  for (let s = 0; s < sections.length; s += 1) {
    const sec = sections[s];
    const dt = String(sec.deviceType || '').trim();
    const cmds = Array.isArray(sec.commands) ? sec.commands : [];
    for (let c = 0; c < cmds.length; c += 1) {
      const row = cmds[c];
      const command = String(row.command || '').trim();
      if (!command) continue;
      flat.push({
        deviceType: dt,
        label: String(row.label || '').trim(),
        command,
      });
    }
  }
  return flat;
}

const AdminDashboard = ({ initialTab = 'allRequests' }) => {
    const [requests, setRequests] = useState([]);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [phoneKind, setPhoneKind] = useState(PHONE_KIND_MOBILE);
    const [department, setDepartment] = useState('');
    const [departmentName, setDepartmentName] = useState('');
    const [departments, setDepartments] = useState([]);
    const [logoUrl, setLogoUrl] = useState('');
    const [faviconUrl, setFaviconUrl] = useState('');
    const [contactsList, setContactsList] = useState([]);
    const [lobbyChatEnabled, setLobbyChatEnabled] = useState(true);
    const [pingerSshIdleTimeoutMinutes, setPingerSshIdleTimeoutMinutes] = useState(5);
    const [pingerSshSaveBusy, setPingerSshSaveBusy] = useState(false);
    const [pingerSshCmdSections, setPingerSshCmdSections] = useState([]);
    const [pingerSshCmdSaveBusy, setPingerSshCmdSaveBusy] = useState(false);
    const pingerSshCmdImportInputRef = useRef(null);
    const [pingerDistinctTypes, setPingerDistinctTypes] = useState([]);
    const [newPingerCmdGroupPick, setNewPingerCmdGroupPick] = useState('');
    const [checkmkUiEnabled, setCheckmkUiEnabled] = useState(true);
    const [lobbySaveBusy, setLobbySaveBusy] = useState(false);
    const [deploymentSections, setDeploymentSections] = useState(null);
    const [deploymentLoadError, setDeploymentLoadError] = useState('');
    const [deploymentPrecedence, setDeploymentPrecedence] = useState('');
    const [deploymentSaveBusy, setDeploymentSaveBusy] = useState(null);
    const [motdForm, setMotdForm] = useState(null);
    const [motdLoadError, setMotdLoadError] = useState('');
    const [motdSaveBusy, setMotdSaveBusy] = useState(false);
    const [motdRegenBusy, setMotdRegenBusy] = useState(false);
    /** null = show all Settings cards; otherwise single section key: 'branding' | 'deployment-overview' | 'deployment-{id}' */
    const [settingsSectionFocus, setSettingsSectionFocus] = useState(null);
    const [shortcutsList, setShortcutsList] = useState([]);
    const [shortcutModalOpen, setShortcutModalOpen] = useState(false);
    const [editingShortcutId, setEditingShortcutId] = useState(null);
    const [scTitle, setScTitle] = useState('');
    const [scDesc, setScDesc] = useState('');
    const [scUrl, setScUrl] = useState('');
    const [scCategory, setScCategory] = useState('Dev');
    const [scImg, setScImg] = useState('');
    const [scSort, setScSort] = useState(0);
    const [scAdminOnly, setScAdminOnly] = useState(false);
    const [scUseFaviconFromUrl, setScUseFaviconFromUrl] = useState(false);
    const [scSummary, setScSummary] = useState('');
    const [scUseCases, setScUseCases] = useState([]);
    const [scExamples, setScExamples] = useState([]);
    const [shortcutModalError, setShortcutModalError] = useState('');
    const [shortcutSearchQuery, setShortcutSearchQuery] = useState('');
    const [helpLibSearchQuery, setHelpLibSearchQuery] = useState('');
    const [manPageModalOpen, setManPageModalOpen] = useState(false);
    const [mpEditingId, setMpEditingId] = useState(null);
    const [mpAppTitle, setMpAppTitle] = useState('');
    const [mpSummary, setMpSummary] = useState('');
    const [mpUseCases, setMpUseCases] = useState([]);
    const [mpExamples, setMpExamples] = useState([]);
    const [mpError, setMpError] = useState('');
    const [mpBusy, setMpBusy] = useState(false);
    const [status, setStatus] = useState('pending');
    const [commentText, setCommentText] = useState('');
    const [assignedTo, setAssignedTo] = useState(null);
    const [selectedRequest, setSelectedRequest] = useState(null);
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    /** Bumped on Settings saves so the success alert re-mounts and plays a short animation. */
    const [settingsSaveFlashKey, setSettingsSaveFlashKey] = useState(0);
    const [currentTab, setCurrentTab] = useState(initialTab);
    const [notificationTitle, setNotificationTitle] = useState('');
    const [notificationDescription, setNotificationDescription] = useState('');
    const [notificationIcon, setNotificationIcon] = useState('📢');
    const [notificationLink, setNotificationLink] = useState('');
    const [notifications, setNotifications] = useState([]);
    const [editingNotificationId, setEditingNotificationId] = useState(null);
    const [user, setUser] = useState(null);

    const [adminUsers, setAdminUsers] = useState([]);
    const [searchTerm, setSearchTerm] = useState(''); 
    const [allRequestsQuery, setAllRequestsQuery] = useState('');

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [sortCriteria, setSortCriteria] = useState('date-desc');
    const [assignedFilter, setAssignedFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState("all");
    /** All Requests: quick-assign row in flight */
    const [assigningTicketId, setAssigningTicketId] = useState(null);

const [checkmkPayload, setCheckmkPayload] = useState(null);
const [checkmkLoading, setCheckmkLoading] = useState(false);
const [adminChatUsername, setAdminChatUsername] = useState('');
const [adminChatPickLabel, setAdminChatPickLabel] = useState('');
const [adminChatUserSearchQuery, setAdminChatUserSearchQuery] = useState('');
const [adminChatUserHits, setAdminChatUserHits] = useState([]);
const [adminChatUserSearchLoading, setAdminChatUserSearchLoading] = useState(false);
const [adminChatConversations, setAdminChatConversations] = useState([]);
const [adminChatConvLoading, setAdminChatConvLoading] = useState(false);
const [adminChatSelectedId, setAdminChatSelectedId] = useState(null);
const [adminChatMessages, setAdminChatMessages] = useState([]);
const [adminChatMsgLoading, setAdminChatMsgLoading] = useState(false);
const adminChatDirTimerRef = useRef(null);
const viewModalRef = useRef(null);

const editModalRef = useRef(null);
const commentModalRef = useRef(null);

useEffect(() => {
  if (isViewModalOpen) {
    const handleClickOutside = (event) => {
      if (
        viewModalRef.current &&
        !viewModalRef.current.contains(event.target)
      ) {
        setIsViewModalOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }
}, [isViewModalOpen]);

useEffect(() => {
  if (isEditModalOpen) {
    const handleClickOutside = (event) => {
      if (
        editModalRef.current &&
        !editModalRef.current.contains(event.target)
      ) {
        setIsEditModalOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }
}, [isEditModalOpen]);


useEffect(() => {
  if (isCommentModalOpen) {
    const handleClickOutside = (event) => {
      if (
        commentModalRef.current &&
        !commentModalRef.current.contains(event.target)
      ) {
        setIsCommentModalOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }
}, [isCommentModalOpen]);

    useEffect(() => {
        const fetchInitialData = async () => {
          const storedToken = localStorage.getItem('token');
          if (storedToken) {
            try {
              const decoded = jwtDecode(storedToken);

              if (isJwtExpired(decoded)) {
                localStorage.removeItem('token');
                return;
              }
      
              setUser(decoded);
             
            } catch (err) {
              console.error("Invalid token in localStorage");
              localStorage.removeItem('token');
            }
          }
    
        };        
        fetchInitialData();

        fetchAdminUsers();
        fetchRequests();
        fetchDepartments();
        fetchSettings();
        if (currentTab === 'notifications') fetchNotifications();
        if (currentTab === 'shortcuts' || currentTab === 'helpLibrary') fetchShortcuts();
    }, [currentTab]);

    const fetchCheckmkDownHosts = useCallback(async () => {
      if (checkmkUiEnabled === false) {
        setCheckmkPayload({
          checkmkUiEnabled: false,
          configured: false,
          hosts: [],
          message:
            'Checkmk is disabled on this deployment (CHECKMK_UI=false). Enable in the server environment to use this tab.',
        });
        return;
      }
      try {
        setCheckmkLoading(true);
        setError('');
        const token = localStorage.getItem('token');
        const res = await fetch('/api/admin/checkmk/down-hosts', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (data.checkmkUiEnabled === false) {
          setCheckmkUiEnabled(false);
          setCheckmkPayload({
            checkmkUiEnabled: false,
            configured: false,
            hosts: [],
            message: data.message || 'Checkmk is disabled on this deployment.',
          });
          return;
        }
        if (!res.ok) {
          setCheckmkPayload({
            configured: data.configured !== false,
            hosts: [],
            error: data.error || `HTTP ${res.status}`,
          });
          return;
        }
        setCheckmkPayload(data);
      } catch (e) {
        setCheckmkPayload({ configured: true, hosts: [], error: e.message || 'Request failed' });
      } finally {
        setCheckmkLoading(false);
      }
    }, [checkmkUiEnabled]);

    const fetchAdminChatDirectory = async (q) => {
      const token = localStorage.getItem('token');
      const query = String(q || '').trim();
      if (query.length < 1) {
        setAdminChatUserHits([]);
        return;
      }
      setAdminChatUserSearchLoading(true);
      try {
        const res = await fetch(`/api/chat/directory?q=${encodeURIComponent(query)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
        setAdminChatUserHits(Array.isArray(data.users) ? data.users : []);
      } catch {
        setAdminChatUserHits([]);
      } finally {
        setAdminChatUserSearchLoading(false);
      }
    };

    const pickAdminChatUser = (hit) => {
      if (!hit || !hit.username) return;
      setAdminChatUsername(String(hit.username).trim());
      setAdminChatPickLabel(
        `${hit.displayName && String(hit.displayName).trim() ? hit.displayName : hit.username} (${hit.username})`,
      );
      setAdminChatUserSearchQuery('');
      setAdminChatUserHits([]);
      setAdminChatConversations([]);
      setAdminChatSelectedId(null);
      setAdminChatMessages([]);
    };

    const fetchAdminUserChatConversations = async () => {
      const u = adminChatUsername.trim();
      if (!u) {
        setError('Search and select a user, or enter a login name below.');
        return;
      }
      setAdminChatConvLoading(true);
      setError('');
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(
          `/api/chat/admin/user-conversations?forUsername=${encodeURIComponent(u)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
        setAdminChatConversations(Array.isArray(data.conversations) ? data.conversations : []);
        setAdminChatSelectedId(null);
        setAdminChatMessages([]);
      } catch (e) {
        setError(e.message || 'Failed to load chats');
        setAdminChatConversations([]);
      } finally {
        setAdminChatConvLoading(false);
      }
    };

    const fetchAdminUserChatMessages = async (convId) => {
      const u = adminChatUsername.trim();
      if (!u || !convId) return;
      setAdminChatMsgLoading(true);
      setError('');
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(
          `/api/chat/conversations/${encodeURIComponent(convId)}/messages?as=${encodeURIComponent(u)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
        setAdminChatMessages(Array.isArray(data.messages) ? data.messages : []);
      } catch (e) {
        setError(e.message || 'Failed to load messages');
        setAdminChatMessages([]);
      } finally {
        setAdminChatMsgLoading(false);
      }
    };

    useEffect(() => {
      if (currentTab !== 'checkmk') return;
      if (checkmkUiEnabled === false) return;
      fetchCheckmkDownHosts();
    }, [currentTab, checkmkUiEnabled, fetchCheckmkDownHosts]);

    useEffect(() => {
      if (checkmkUiEnabled !== false || currentTab !== 'checkmk') return;
      setCurrentTab('allRequests');
    }, [checkmkUiEnabled, currentTab]);

    useEffect(() => {
      if (currentTab !== 'settings') {
        setSettingsSectionFocus(null);
      }
    }, [currentTab]);

    useEffect(() => {
      if (currentTab !== 'settings') return;
      const sc = document.querySelector('.admin-main-scroll');
      if (!sc) return;
      const oy = window.getComputedStyle(sc).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return;
      sc.scrollTop = 0;
    }, [settingsSectionFocus, currentTab]);

    useEffect(() => {
      if (currentTab !== 'settings') return;
      let cancelled = false;
      (async () => {
        setDeploymentLoadError('');
        setMotdLoadError('');
        try {
          const token = localStorage.getItem('token');
          if (!token) {
            if (!cancelled) {
              setDeploymentLoadError('Not signed in');
              setMotdLoadError('Not signed in');
            }
            return;
          }
          const r = await fetch('/api/settings/deployment', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
          if (cancelled) return;
          if (data.sections) {
            const clone = JSON.parse(JSON.stringify(data.sections));
            Object.keys(clone).forEach((sec) => {
              Object.keys(clone[sec]).forEach((k) => {
                clone[sec][k] = normalizeDeploymentFieldValue(k, clone[sec][k]);
              });
            });
            setDeploymentSections(clone);
          }
          if (data.precedence) setDeploymentPrecedence(String(data.precedence));
        } catch (e) {
          if (!cancelled) {
            setDeploymentLoadError(e.message || 'Failed to load deployment settings');
            setDeploymentSections(null);
          }
        }
        try {
          const token = localStorage.getItem('token');
          if (!token || cancelled) return;
          const rm = await fetch('/api/settings/motd', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const motdData = await rm.json().catch(() => ({}));
          if (!rm.ok) throw new Error(motdData.message || `HTTP ${rm.status}`);
          if (!cancelled) {
            setMotdForm(motdData);
            setMotdLoadError('');
          }
        } catch (e) {
          if (!cancelled) {
            setMotdLoadError(e.message || 'Failed to load message-of-the-day settings');
            setMotdForm(null);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [currentTab]);

    useEffect(
      () => () => {
        if (adminChatDirTimerRef.current) {
          window.clearTimeout(adminChatDirTimerRef.current);
        }
      },
      [],
    );

    const filteredShortcutsList = useMemo(() => {
      const q = shortcutSearchQuery.trim().toLowerCase();
      if (!q) return shortcutsList;
      return shortcutsList.filter((s) => {
        const hay = [s.title, s.url, s.category, s.description, s.imgSrc, s.alt]
          .filter((x) => x != null && String(x).trim() !== '')
          .map((x) => String(x).toLowerCase())
          .join('\n');
        return hay.includes(q);
      });
    }, [shortcutsList, shortcutSearchQuery]);

    const formatDate = (dateString) => {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      });
    };

    const formatDateTime = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    const adminTicketDescPreview = (d) => {
      const t = String(d || '').trim();
      if (!t) return '';
      return t.length > 100 ? `${t.slice(0, 100)}…` : t;
    };

    const resetRequestForm = () => {
      setTitle('');
      setDescription('');
      setPhoneNumber('');
      setPhoneKind(PHONE_KIND_MOBILE);
      setDepartment('');
      setStatus('pending');
      setAssignedTo(null);
    };

    const flashSettingsSuccess = useCallback((msg) => {
      setSuccessMessage(msg);
      setSettingsSaveFlashKey((k) => k + 1);
    }, []);

  

  const fetchSettings = async () => {
      try {
          const response = await fetch('/api/settings/public');
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          const data = await response.json();
          setLogoUrl(data.logoUrl || 'logo192.png');
          setFaviconUrl(
            (data.faviconUrl || data.logoUrl || 'logo192.png').trim() || 'logo192.png',
          );
          if (Array.isArray(data.contacts)) {
            setContactsList(normalizeAdminContactRows(data.contacts));
          }
          setLobbyChatEnabled(data.lobbyChatEnabled !== false);
          setCheckmkUiEnabled(data.checkmkUiEnabled !== false);
          {
            const pm = Number(data.pingerSshIdleTimeoutMinutes);
            if (Number.isFinite(pm) && pm >= 1) {
              setPingerSshIdleTimeoutMinutes(Math.min(Math.round(pm), 1440));
            }
          }
          setPingerSshCmdSections(pingerSshCommandsApiToSections(data.pingerSshCommonCommands));
      } catch (err) {
          setError(`Failed to fetch settings. ${err.message}`);
      }
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const r = await fetch('/api/pinger/hosts/export', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return;
        const hosts = Array.isArray(d.hosts) ? d.hosts : [];
        const byLower = new Map();
        for (let i = 0; i < hosts.length; i += 1) {
          const t = String(hosts[i].type || '').trim();
          if (!t) continue;
          const k = t.toLowerCase();
          if (!byLower.has(k)) byLower.set(k, t);
        }
        setPingerDistinctTypes(Array.from(byLower.values()).sort((a, b) => a.localeCompare(b)));
      } catch {
        /* ignore */
      }
  };

  const fetchShortcuts = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/shortcuts', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      setShortcutsList(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(`Failed to load shortcuts. ${err.message}`);
    }
  };

  const resetShortcutForm = () => {
    setEditingShortcutId(null);
    setScTitle('');
    setScDesc('');
    setScUrl('');
    setScCategory('Dev');
    setScImg('');
    setScSort(0);
    setScAdminOnly(false);
    setScUseFaviconFromUrl(false);
    setScSummary('');
    setScUseCases([]);
    setScExamples([]);
    setShortcutModalError('');
  };

  const moveContactRow = (index, delta) => {
    setContactsList((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const t = next[index];
      next[index] = next[j];
      next[j] = t;
      return next;
    });
  };

  const handleSaveContacts = async () => {
    try {
      const response = await fetch('/api/settings/contacts', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ contacts: adminContactsPayload(contactsList) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
      if (Array.isArray(data.contacts)) setContactsList(normalizeAdminContactRows(data.contacts));
      flashSettingsSuccess('Contacts saved.');
    } catch (err) {
      setError(`Failed to save contacts. ${err.message}`);
    }
  };

  const handleSaveShortcut = async () => {
    if (!scTitle.trim() || !scUrl.trim()) return;
    try {
      setError('');
      setShortcutModalError('');
      const token = localStorage.getItem('token');
      let imgSrc = scImg.trim();
      if (scUseFaviconFromUrl) {
        const r = await fetch(
          `/api/settings/resolve-favicon?url=${encodeURIComponent(scUrl.trim())}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || `Could not get favicon (HTTP ${r.status})`);
        imgSrc = typeof d.imgSrc === 'string' ? d.imgSrc.trim() : '';
        if (!imgSrc) throw new Error('No favicon URL returned');
        setScImg(imgSrc);
      }
      const cleanUseCases = scUseCases
        .map((row) => String(row || '').trim())
        .filter((row) => row.length > 0);
      const cleanExamples = scExamples
        .map((row) => ({
          title: String(row.title || '').trim(),
          body: String(row.body || ''),
        }))
        .filter((row) => row.title || row.body.trim());
      const body = {
        title: scTitle.trim(),
        description: scDesc.trim(),
        url: scUrl.trim(),
        category: scCategory.trim() || 'General',
        imgSrc,
        sortOrder: Number(scSort) || 0,
        adminOnly: scAdminOnly,
        summary: scSummary.trim(),
        useCases: cleanUseCases,
        examples: cleanExamples,
      };
      if (editingShortcutId) {
        const response = await fetch(`/api/shortcuts/${editingShortcutId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const updated = await response.json();
        setShortcutsList(shortcutsList.map((s) => (s._id === editingShortcutId ? updated : s)));
        setSuccessMessage('Shortcut updated.');
      } else {
        const response = await fetch('/api/shortcuts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const created = await response.json();
        setShortcutsList([...shortcutsList, created]);
        setSuccessMessage('Shortcut added.');
      }
      setScUseFaviconFromUrl(false);
      resetShortcutForm();
      setShortcutModalOpen(false);
    } catch (err) {
      const msg = `Shortcut save failed. ${err.message}`;
      setShortcutModalError(msg);
      setError(msg);
    }
  };

  const handleDeleteShortcut = async (id) => {
    if (!window.confirm('Remove this home page shortcut?')) return;
    try {
      const response = await fetch(`/api/shortcuts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setShortcutsList(shortcutsList.filter((s) => s._id !== id));
      setSuccessMessage('Shortcut removed.');
    } catch (err) {
      setError(`Delete failed. ${err.message}`);
    }
  };

  const openManPageEditor = (s) => {
    setMpEditingId(s._id);
    setMpAppTitle(String(s.title || '').trim() || 'Untitled app');
    setMpSummary(String(s.summary || ''));
    setMpUseCases(
      Array.isArray(s.useCases) ? s.useCases.map((x) => String(x || '')) : [],
    );
    setMpExamples(
      Array.isArray(s.examples)
        ? s.examples.map((ex) => ({
            title: String((ex && ex.title) || ''),
            body: String((ex && ex.body) || ''),
          }))
        : [],
    );
    setMpError('');
    setManPageModalOpen(true);
  };

  const closeManPageEditor = () => {
    setManPageModalOpen(false);
    setMpEditingId(null);
    setMpAppTitle('');
    setMpSummary('');
    setMpUseCases([]);
    setMpExamples([]);
    setMpError('');
    setMpBusy(false);
  };

  const handleSaveManPage = async () => {
    if (!mpEditingId) return;
    try {
      setMpError('');
      setMpBusy(true);
      const cleanUseCases = mpUseCases
        .map((row) => String(row || '').trim())
        .filter((row) => row.length > 0);
      const cleanExamples = mpExamples
        .map((row) => ({
          title: String(row.title || '').trim(),
          body: String(row.body || ''),
        }))
        .filter((row) => row.title || row.body.trim());
      const body = {
        summary: mpSummary.trim(),
        useCases: cleanUseCases,
        examples: cleanExamples,
      };
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/shortcuts/${mpEditingId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const updated = await response.json();
      setShortcutsList((prev) =>
        prev.map((s) => (s._id === mpEditingId ? updated : s)),
      );
      setSuccessMessage('Man-page saved.');
      closeManPageEditor();
    } catch (err) {
      const msg = err.message || 'Save failed';
      setMpError(msg);
      setMpBusy(false);
    }
  };

  const filteredHelpLibList = useMemo(() => {
    const q = helpLibSearchQuery.trim().toLowerCase();
    const sorted = [...shortcutsList].sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        String(a.title || '').localeCompare(String(b.title || '')),
    );
    if (!q) return sorted;
    return sorted.filter((s) => {
      const useCasesText = Array.isArray(s.useCases) ? s.useCases.join('\n') : '';
      const examplesText = Array.isArray(s.examples)
        ? s.examples.map((ex) => `${ex?.title || ''}\n${ex?.body || ''}`).join('\n')
        : '';
      const hay = [s.title, s.category, s.summary, s.description, useCasesText, examplesText]
        .filter((x) => x != null && String(x).trim() !== '')
        .map((x) => String(x).toLowerCase())
        .join('\n');
      return hay.includes(q);
    });
  }, [shortcutsList, helpLibSearchQuery]);

  const handleExportShortcutsCsv = () => {
    if (shortcutsList.length === 0) {
      setError('No shortcuts to export.');
      return;
    }
    const sorted = [...shortcutsList].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.title || '').localeCompare(b.title || ''),
    );
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['Title', 'URL', 'Description', 'Category', 'ImgSrc', 'Alt', 'Sort Order', 'Admin Only'];
    const rows = sorted.map((s) => [
      esc(s.title),
      esc(s.url),
      esc(s.description || ''),
      esc(s.category || ''),
      esc(s.imgSrc || ''),
      esc(s.alt || ''),
      esc(s.sortOrder ?? 0),
      esc(s.adminOnly ? 'true' : 'false'),
    ]);
    const BOM = '\uFEFF';
    const csvContent = [BOM + headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `shortcuts_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setError('');
    setSuccessMessage('Shortcuts exported.');
  };

  const handleImportShortcutsCsv = (event) => {
    const file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        setError('');
        const text = e.target.result;
        const matrix = parseCsv(text);
        const rawRows = mapShortcutImportRows(matrix);
        const shortcuts = rawRows
          .filter((r) => String(r.title || '').trim() && String(r.url || '').trim())
          .map((r) => ({
            title: String(r.title).trim(),
            url: String(r.url).trim(),
            description:
              r.description != null && String(r.description).trim() !== ''
                ? String(r.description).trim()
                : '',
            category:
              r.category != null && String(r.category).trim() !== ''
                ? String(r.category).trim()
                : '',
            imgSrc:
              r.imgSrc != null && String(r.imgSrc).trim() !== '' ? String(r.imgSrc).trim() : '',
            alt: r.alt != null && String(r.alt).trim() !== '' ? String(r.alt).trim() : '',
            sortOrder: r.sortOrder != null && String(r.sortOrder).trim() !== '' ? r.sortOrder : '',
            adminOnly: r.adminOnly,
          }));
        if (shortcuts.length === 0) {
          setError(
            'No valid rows. Each row needs Title and URL. Other columns are optional; omit a column or leave cells empty for defaults.',
          );
          return;
        }
        const response = await fetch('/api/shortcuts/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`,
          },
          body: JSON.stringify({ shortcuts }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
        await fetchShortcuts();
        setSuccessMessage(`Imported ${data.imported} shortcuts. Skipped ${data.skipped || 0}.`);
      } catch (err) {
        setError(err.message || 'Import failed');
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const handleImportRequestsCsv = (event) => {
    const file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        setError('');
        const text = e.target.result;
        const matrix = parseCsv(text);
        const rawRows = mapTicketImportRows(matrix);
        const tickets = rawRows
          .filter((r) => String(r.title || '').trim() && String(r.createdBy || '').trim())
          .map((r) => ({
            title: String(r.title).trim(),
            description: String(r.description || '').trim(),
            createdBy: String(r.createdBy).trim(),
            phoneNumber: String(r.phoneNumber || '').trim(),
            department: String(r.department || '').trim(),
            status: String(r.status || 'pending').trim().toLowerCase(),
            assignedTo: String(r.assignedTo || '').trim() || null,
            createdAt: r.createdAt ? String(r.createdAt).trim() : undefined,
          }));
        if (tickets.length === 0) {
          setError('No valid rows. Each row needs Title and Created By. Other columns are optional and can be omitted.');
          return;
        }
        const response = await fetch('/api/tickets/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`,
          },
          body: JSON.stringify({ tickets }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
        const listRes = await fetch('/api/tickets/requests', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        });
        if (listRes.ok) setRequests(await listRes.json());
        setSuccessMessage(`Imported ${data.imported} requests. Skipped ${data.skipped || 0}.`);
      } catch (err) {
        setError(err.message || 'Import failed');
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const handleSaveLogo = async () => {
      if (!logoUrl.trim()) return;
      try {
          setError('');
          const response = await fetch('/api/settings/logo', {
              method: 'PUT',
              headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${localStorage.getItem('token')}`
              },
              body: JSON.stringify({ logoUrl }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
          setLogoUrl(data.logoUrl);
          flashSettingsSuccess("Logo updated successfully. Refresh the page to see it in the header.");
      } catch (error) {
          setError(`Failed to update logo. ${error.message}`);
      }
  };

  const handleSaveFavicon = async () => {
    if (!faviconUrl.trim()) return;
    try {
      setError('');
      const response = await fetch('/api/settings/favicon', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ faviconUrl: faviconUrl.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      setFaviconUrl(data.faviconUrl);
      flashSettingsSuccess('Favicon updated. Refresh the page or open a new tab to see the browser tab icon.');
    } catch (error) {
      setError(`Failed to update favicon. ${error.message}`);
    }
  };

  const handleLobbyChatToggle = async (nextEnabled) => {
    if (lobbySaveBusy) return;
    setLobbySaveBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/lobby-chat', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ lobbyChatEnabled: nextEnabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      setLobbyChatEnabled(!!data.lobbyChatEnabled);
      flashSettingsSuccess('Chat setting saved.');
    } catch (error) {
      setError(`Failed to update chat. ${error.message}`);
    } finally {
      setLobbySaveBusy(false);
    }
  };

  const handleSavePingerSshIdle = async () => {
    if (pingerSshSaveBusy) return;
    setPingerSshSaveBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/pinger-ssh', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ pingerSshIdleTimeoutMinutes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      const pm = Number(data.pingerSshIdleTimeoutMinutes);
      if (Number.isFinite(pm)) setPingerSshIdleTimeoutMinutes(pm);
      flashSettingsSuccess('Pinger SSH setting saved.');
    } catch (error) {
      setError(`Failed to save Pinger SSH setting. ${error.message}`);
    } finally {
      setPingerSshSaveBusy(false);
    }
  };

  const movePingerSshCmdRow = (sectionIndex, commandIndex, delta) => {
    setPingerSshCmdSections((prev) => {
      const next = prev.map((s) => ({ ...s, commands: s.commands.map((c) => ({ ...c })) }));
      const section = next[sectionIndex];
      if (!section) return prev;
      const targetIndex = commandIndex + delta;
      if (targetIndex < 0 || targetIndex >= section.commands.length) return prev;
      [section.commands[commandIndex], section.commands[targetIndex]] = [
        section.commands[targetIndex],
        section.commands[commandIndex],
      ];
      return next;
    });
  };

  const handleExportPingerSshCommands = () => {
    const payload = pingerSshSectionsToApiPayload(pingerSshCmdSections);
    if (payload.length === 0) {
      setError('No commands to export.');
      return;
    }
    const fileName = `pinger-ssh-commands-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    flashSettingsSuccess('Pinger CLI commands exported.');
  };

  const handleImportPingerSshCommands = (event) => {
    const file = event.target && event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const raw = JSON.parse(text);
        const payload = Array.isArray(raw) ? raw : raw?.pingerSshCommonCommands || raw?.commands || [];
        if (!Array.isArray(payload) || payload.length === 0) {
          setError('Imported JSON must be an array of common CLI command objects.');
          return;
        }
        setPingerSshCmdSections(pingerSshCommandsApiToSections(payload));
        flashSettingsSuccess('Imported Pinger CLI commands. Click Save commands to persist.');
      } catch (err) {
        setError(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const handleOpenPingerSshCmdImport = () => {
    if (pingerSshCmdImportInputRef.current) {
      pingerSshCmdImportInputRef.current.click();
    }
  };

  const handleSavePingerSshCommands = async () => {
    if (pingerSshCmdSaveBusy) return;
    setPingerSshCmdSaveBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/pinger-ssh', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ pingerSshCommonCommands: pingerSshSectionsToApiPayload(pingerSshCmdSections) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
      setPingerSshCmdSections(pingerSshCommandsApiToSections(data.pingerSshCommonCommands));
      flashSettingsSuccess('Pinger CLI commands saved.');
    } catch (error) {
      setError(`Failed to save Pinger CLI commands. ${error.message}`);
    } finally {
      setPingerSshCmdSaveBusy(false);
    }
  };

  const handleSaveDeploymentSection = async (sectionId) => {
    if (!deploymentSections || !deploymentSections[sectionId]) return;
    setDeploymentSaveBusy(sectionId);
    setError('');
    try {
      const block = deploymentSections[sectionId];
      const patch = {};
      Object.keys(block).forEach((k) => {
        if (DEPLOYMENT_SECRET_KEYS.has(k)) {
          const v = block[k];
          if (v === undefined || v === null || String(v).trim() === '' || String(v) === '********') {
            return;
          }
          patch[k] = String(v);
          return;
        }
        const out = coerceDeploymentOutgoingValue(k, block[k]);
        if (out === null) {
          patch[k] = null;
        } else {
          patch[k] = out;
        }
      });
      const response = await fetch('/api/settings/deployment', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      if (data.sections) {
        const clone = JSON.parse(JSON.stringify(data.sections));
        Object.keys(clone).forEach((sec) => {
          Object.keys(clone[sec]).forEach((k) => {
            clone[sec][k] = normalizeDeploymentFieldValue(k, clone[sec][k]);
          });
        });
        setDeploymentSections(clone);
      } else {
        setDeploymentSections((prev) => (prev ? JSON.parse(JSON.stringify(prev)) : prev));
      }
      let msg = 'Deployment settings saved.';
      if (data.restartRecommended) {
        msg += ' Restart the application container if SSO or Checkmk does not pick up changes.';
      }
      flashSettingsSuccess(msg);
      await fetchSettings();
    } catch (error) {
      setError(`Failed to save deployment settings. ${error.message}`);
    } finally {
      setDeploymentSaveBusy(null);
    }
  };

  const handleSaveMotd = async () => {
    if (!motdForm) return;
    setMotdSaveBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/motd', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(motdForm),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      setMotdForm(data);
      flashSettingsSuccess('Message of the day settings saved.');
    } catch (error) {
      setError(`Failed to save message of the day. ${error.message}`);
    } finally {
      setMotdSaveBusy(false);
    }
  };

  const handleRegenerateMotd = async () => {
    setMotdRegenBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/motd/regenerate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `HTTP error! status: ${response.status}`);
      setMotdForm(data);
      flashSettingsSuccess('Message regenerated with Ollama.');
    } catch (error) {
      setError(`Regenerate failed. ${error.message}`);
    } finally {
      setMotdRegenBusy(false);
    }
  };

  const settingsSectionAnchorId = useCallback((key) => {
    if (!key || key === 'branding') return 'admin-settings-section-branding';
    if (key === 'motd') return 'admin-settings-section-motd';
    if (key === 'deployment-overview') return 'admin-settings-section-deployment-overview';
    if (typeof key === 'string' && key.startsWith('deployment-')) {
      const sid = key.slice('deployment-'.length);
      return sid ? `admin-settings-section-deployment-${sid}` : 'admin-settings-section-deployment-overview';
    }
    return 'admin-settings-section-branding';
  }, []);

  const focusSettingsSection = useCallback(
    (key) => {
      setSettingsSectionFocus(key);
      window.requestAnimationFrame(() => {
        const scrollPanel = document.querySelector('.admin-main-scroll');
        if (scrollPanel) {
          const oy = window.getComputedStyle(scrollPanel).overflowY;
          if (oy === 'auto' || oy === 'scroll') {
            scrollPanel.scrollTop = 0;
            return;
          }
        }
        const anchorId = settingsSectionAnchorId(key);
        const el = document.getElementById(anchorId);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    },
    [settingsSectionAnchorId],
  );

  const fetchDepartments = async () => {
      try {
          const response = await fetch('/api/departments');
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          const data = await response.json();
          setDepartments(data);
      } catch (err) {
          setError(`Failed to fetch departments. ${err.message}`);
      }
  };

  const handleSaveDepartment = async () => {
      if (!departmentName.trim()) return;
      try {
          const response = await fetch('/api/departments', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${localStorage.getItem('token')}`
              },
              body: JSON.stringify({ name: departmentName })
          });
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          const data = await response.json();
          setDepartments([...departments, data]);
          setDepartmentName('');
          setSuccessMessage("Department added successfully!");
      } catch (error) {
          setError(`Failed to add department. ${error.message}`);
      }
  };

  const handleDeleteDepartment = async (departmentId) => {
      if (!window.confirm("Are you sure you want to delete this department?")) return;
      try {
          const response = await fetch(`/api/departments/${departmentId}`, {
              method: 'DELETE',
              headers: {
                  Authorization: `Bearer ${localStorage.getItem('token')}`
              }
          });
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          setDepartments(departments.filter(item => item._id !== departmentId));
          setSuccessMessage("Department deleted successfully!");
      } catch (error) {
          setError(`Failed to delete department. ${error.message}`);
      }
  };
  

    const getFilteredAndSortedRequests = (
        requests,
        assignedFilter,
        statusFilter,
        sortCriteria,
        searchQuery = ''
      ) => {
        const query = String(searchQuery || '').trim().toLowerCase();
        return requests
          .filter((request) => {
            if (assignedFilter === "assigned" && !request.assignedTo) return false;
            if (assignedFilter === "unassigned" && request.assignedTo) return false;
      
            if (statusFilter !== "all" && request.status !== statusFilter) return false;
            if (query) {
              const hay = [
                request.title,
                request.description,
                request.createdBy,
                request.assignedTo,
                request.assignedToDisplayName,
                request.department,
                request.status,
              ]
                .map((x) => String(x || '').toLowerCase())
                .join(' ');
              if (!hay.includes(query)) return false;
            }
      
            return true;
          })
          .sort((a, b) => {
           
            if (sortCriteria === "date-desc") return new Date(b.createdAt) - new Date(a.createdAt);
            if (sortCriteria === "date-asc") return new Date(a.createdAt) - new Date(b.createdAt);
            if (sortCriteria === "assignedTo") {
              const aUser = a.assignedTo
                ? (a.assignedToDisplayName || a.assignedTo)
                : "Unassigned";
              const bUser = b.assignedTo
                ? (b.assignedToDisplayName || b.assignedTo)
                : "Unassigned";
              return aUser.localeCompare(bUser);
            }
            if (sortCriteria === "status") return a.status.localeCompare(b.status);
            return 0;
          });
      };
      const fetchAdminUsers = async () => {
        try {
            const response = await fetch('/api/admin-users', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setAdminUsers(data);
        } catch (err) {
            setError(err.message);
        }
    };
    const fetchRequests = async () => {
        try {
            const response = await fetch('/api/tickets/requests', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setRequests(data);
        } catch (error) {
            setError(`Failed to fetch requests: ${error.message}`);
        }
    };
    const fetchNotifications = async () => {
        try {
            const response = await fetch('/api/notifications');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setNotifications(data);
        } catch (error) {
            setError(`Failed to fetch notifications: ${error.message}`);
        }
    };
    const closeNotificationModal = () => {
        setIsModalOpen(false);
        setEditingNotificationId(null);
        setNotificationTitle('');
        setNotificationDescription('');
        setNotificationIcon('📢');
        setNotificationLink('');
    };

    const handleSaveNotification = async () => {
      if (!notificationTitle || !notificationDescription) {
        setError('Please fill in all required fields.');
        return;
      }

      try {
        const token = localStorage.getItem('token');
        const body = {
          title: notificationTitle,
          description: notificationDescription,
          icon: notificationIcon,
          link: notificationLink.trim() ? notificationLink.trim() : null,
        };

        if (editingNotificationId) {
          const existing = notifications.find((n) => String(n._id) === String(editingNotificationId));
          const response = await fetch(`/api/notifications/${editingNotificationId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...body,
              isVisible: existing ? existing.isVisible !== false : true,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            setError(errorData.message || 'Failed to update notification');
            return;
          }

          const updatedNotification = await response.json();
          setNotifications(
            notifications.map((n) =>
              String(n._id) === String(editingNotificationId) ? updatedNotification : n,
            ),
          );
          setSuccessMessage('Notification updated successfully!');
        } else {
          const response = await fetch('/api/notifications', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...body,
              isVisible: true,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            setError(errorData.message || 'Failed to add notification');
            return;
          }

          const newNotification = await response.json();
          setNotifications([newNotification, ...notifications]);
          setSuccessMessage('Notification added successfully!');
        }

        closeNotificationModal();
      } catch (err) {
        setError(`Error saving notification: ${err.message}`);
      }
    };

    const handleDeleteNotification = async (id) => {
        if (!window.confirm("Are you sure you want to delete this notification?")) return;
        try {
            const response = await fetch(`/api/notifications/${id}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`,
                },
            });
            if (!response.ok) {
                const errorData = await response.json();
                setError(errorData.message || 'Failed to delete notification');
                return;
            }
            setNotifications(notifications.filter(n => n._id !== id));
            if (String(editingNotificationId) === String(id)) {
                closeNotificationModal();
            }
            setSuccessMessage("Notification deleted successfully!");
        } catch (err) {
            setError(`Error deleting notification: ${err.message}`);
        }
    };

    // Function to update notification visibility
    const handleUpdateNotificationVisibility = async (id, isVisible) => {
        try {
            const response = await fetch(`/api/notifications/${id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ isVisible })
            });
            if (!response.ok) {
                const errorData = await response.json();
                setError(errorData.message || 'Failed to update notification visibility');
                return;
            }
            const updatedNotification = await response.json();
            setNotifications(notifications.map(n => n._id === id ? updatedNotification : n));
        } catch (err) {
            setError(`Error updating notification visibility: ${err.message}`);
        }
    };
    const handleCreateNewRequest = async () => {
        if (!title || !description || !isPhoneFormValid(phoneKind, phoneNumber)) return;
        try {
            const newRequestData = {
                title,
                description,
                ...buildPhoneApiBody(phoneKind, phoneNumber),
                department,
                status,
                assignedTo: assignedTo || null,
                createdBy: user.username
            };
            const response = await fetch('/api/tickets/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(newRequestData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setRequests([...requests, data]);
            resetRequestForm();
            setIsEditModalOpen(false);
            setSuccessMessage('New request created successfully!');
        } catch (error) {
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };
    const handleExportFilteredRequests = () => {
      const filteredRequests = getFilteredAndSortedRequests(
        requests,
        assignedFilter,
        statusFilter,
        sortCriteria,
        allRequestsQuery,
      );
    
      if (filteredRequests.length === 0) {
        alert("No requests to export.");
        return;
      }

      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const headers = ["Title", "Description", "Status", "Department", "Phone Number", "Assigned To", "Created By", "Created At"];
      const rows = filteredRequests.map((req) => [
        esc(req.title),
        esc(req.description || ''),
        esc(req.status),
        esc(req.department || ''),
        esc(displayPhoneFromTicket(req)),
        esc(req.assignedTo || ''),
        esc(req.createdBy),
        esc(req.createdAt || ''),
      ]);
   
      const BOM = "\uFEFF";
      const csvContent = [
        BOM + headers.join(","),
        ...rows.map(row => row.join(","))
      ].join("\n");
    
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "filtered_requests.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
 
    const handleUpdateRequest = async () => {
        if (!title || !description || !isPhoneFormValid(phoneKind, phoneNumber)) return;
        try {
            const updatedRequestData = {
                title,
                description,
                ...buildPhoneApiBody(phoneKind, phoneNumber),
                department,
                status,
                assignedTo: assignedTo || selectedRequest.assignedTo
            };
            const response = await fetch(`/api/tickets/requests/${selectedRequest._id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(updatedRequestData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setRequests(requests.map(req => (req._id === selectedRequest._id ? data : req)));
            setSelectedRequest(null);
            resetRequestForm();
            setIsEditModalOpen(false);
            setSuccessMessage('Request updated successfully!');
        } catch (error) {
            setError("Failed to update request. Please try again later.");
        }
    };
    const handleAddComment = async () => {
        if (!selectedRequest || !commentText) return;
        try {
            const commentData = {
                commentedBy: user.username,
                commentText
            };
            const response = await fetch(`/api/tickets/requests/${selectedRequest._id}/comments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(commentData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setRequests(requests.map(req => (req._id === selectedRequest._id ? data : req)));
            setSelectedRequest(data);
            setCommentText('');
            setIsCommentModalOpen(false);
            setSuccessMessage('Comment added successfully!');
        } catch (error) {
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };
    const handleDeleteRequest = async (requestId) => {
        try {
            const response = await fetch(`/api/tickets/requests/${requestId}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            setRequests(requests.filter(req => req._id !== requestId));
            setSuccessMessage('Request deleted successfully!');
        } catch (error) {
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };

    const handleAssignToMe = async (request, e) => {
        e.stopPropagation();
        if (!user?.username || !request?._id) return;
        if (normSam(request.assignedTo) === normSam(user.username)) return;
        const st = formStateFromTicket(request);
        if (!isPhoneFormValid(st.phoneKind, st.phoneNumber)) {
            setError('This ticket’s phone number is incomplete. Open Edit, fix phone, then assign.');
            return;
        }
        setAssigningTicketId(request._id);
        setError('');
        try {
            const body = {
                title: request.title,
                description: request.description,
                ...buildPhoneApiBody(st.phoneKind, st.phoneNumber),
                department: request.department || '',
                status: request.status,
                assignedTo: user.username,
            };
            const response = await fetch(`/api/tickets/requests/${request._id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`,
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || errData.message || `HTTP ${response.status}`);
            }
            const data = await response.json();
            setRequests((prev) => prev.map((r) => (String(r._id) === String(request._id) ? data : r)));
            if (selectedRequest && String(selectedRequest._id) === String(request._id)) {
                setSelectedRequest(data);
            }
            setSuccessMessage('Ticket assigned to you.');
        } catch (err) {
            setError(err.message || 'Could not assign ticket.');
        } finally {
            setAssigningTicketId(null);
        }
    };

    const handleFullDataExport = async (format) => {
        setError('');
        setSuccessMessage('');
        try {
            const token = localStorage.getItem('token');
            const q =
                format === 'json'
                    ? '?format=json'
                    : format === 'gzip'
                      ? '?format=gzip'
                      : format === 'legacy-json'
                        ? '?format=legacy-json'
                        : format === 'legacy-gzip'
                          ? '?format=legacy-gzip'
                          : '?format=zip';
            const r = await fetch(`/api/admin/data/export${q}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                setError(err.message || 'Export failed');
                return;
            }
            const blob = await r.blob();
            const cd = r.headers.get('Content-Disposition') || '';
            const m = cd.match(/filename="([^"]+)"/i);
            const fname = m ? m[1] : `support-center-export-${Date.now()}.zip`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setSuccessMessage('Backup file downloaded.');
        } catch (err) {
            setError(err.message || 'Export failed');
        }
    };

    const handleFullDataImportFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        setError('');
        setSuccessMessage('');
        if (!window.confirm(
            'Replace ALL JSON data in this app (users, tickets, chat, shortcuts, settings, etc.) from this backup, ' +
            'then restore files under uploads/ from the backup (existing filenames are overwritten). This cannot be undone. Continue?',
        )) {
            return;
        }
        try {
            const token = localStorage.getItem('token');
            const formData = new FormData();
            formData.append('file', file);
            const r = await fetch('/api/admin/data/import', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                setError(data.message || 'Import failed');
                return;
            }
            setSuccessMessage(
                `${data.message || 'Import completed'}. ` +
                `Collections replaced: ${data.collectionsReplaced != null ? data.collectionsReplaced : '—'}. ` +
                `Upload files written: ${data.uploadsWritten != null ? data.uploadsWritten : 0}.`,
            );
        } catch (err) {
            setError(err.message || 'Import failed');
        }
    };

    const adminPageMeta = {
      allRequests: { title: 'All requests', subtitle: 'Search filters, CSV import/export, and ticket actions.' },
      assignedToMe: { title: 'Assigned to me', subtitle: 'Tickets where you are the assignee.' },
      notifications: { title: 'Notifications', subtitle: 'Homepage announcement banners and visibility.' },
      departments: { title: 'Departments', subtitle: 'Department names used on tickets.' },
      shortcuts: {
        title: 'Shortcuts',
        subtitle:
          'Home grid quick links and Help library apps (titles, URLs, categories, plus man-page summary, use cases, and examples).',
      },
      helpLibrary: {
        title: 'Help library',
        subtitle:
          'Edit each app’s man-page (summary, use cases, examples) shown on the public Help library tab.',
      },
      contacts: { title: 'Contact page', subtitle: 'Rows shown on the public Contact tab.' },
      settings: {
        title: 'Settings',
        subtitle: 'Branding, message of the day, and deployment / environment overrides.',
      },
      checkmk: { title: 'Checkmk', subtitle: 'Hosts DOWN or UNREACH (from your Checkmk site; admin only).' },
      userChats: {
        title: 'User chats',
        subtitle: 'View another user’s chat list and messages (read-only; same visibility as that user).',
      },
      dataBackup: {
        title: 'Backup & restore',
        subtitle: 'Download or replace all JSON data stores and uploaded files (images, chat attachments).',
      },
    };
    let pageMeta = adminPageMeta[currentTab] || { title: 'Admin', subtitle: '' };
    if (currentTab === 'checkmk' && checkmkUiEnabled === false) {
      pageMeta = {
        ...pageMeta,
        subtitle: 'Checkmk is disabled on this server (CHECKMK_UI=false).',
      };
    }
    if (currentTab === 'settings' && settingsSectionFocus) {
      let sectionLine = '';
      if (settingsSectionFocus === 'branding') {
        sectionLine = 'Branding & access';
      } else if (settingsSectionFocus === 'motd') {
        sectionLine = 'Message of the day (Ollama)';
      } else if (settingsSectionFocus === 'deployment-overview') {
        sectionLine = 'Deployment — Overview';
      } else if (settingsSectionFocus.startsWith('deployment-')) {
        const sid = settingsSectionFocus.slice('deployment-'.length);
        sectionLine = DEPLOYMENT_SECTION_TITLES[sid] || sid;
      }
      if (sectionLine) {
        pageMeta = {
          ...pageMeta,
          subtitle: sectionLine,
        };
      }
    }
    const filteredRequests = getFilteredAndSortedRequests(
      requests,
      assignedFilter,
      statusFilter,
      sortCriteria,
      allRequestsQuery,
    );
    const allRequestStats = {
      total: requests.length,
      shown: filteredRequests.length,
      pending: filteredRequests.filter((r) => r.status === 'pending').length,
      inProgress: filteredRequests.filter((r) => r.status === 'in progress').length,
      closed: filteredRequests.filter((r) => r.status === 'closed').length,
    };

    return (
        <div
          className={`admin-dashboard${
            currentTab === 'settings' ? ' admin-dashboard--settings-body-scroll' : ''
          }`}
        >
          <aside className="admin-sidebar" aria-label="Admin sections">
            <div className="admin-sidebar-head">
              <span className="admin-sidebar-kicker">Support Center</span>
              <strong className="admin-sidebar-title">Admin</strong>
            </div>
            <nav className="admin-nav">
              <div className="admin-nav-group">
                <span className="admin-nav-group-label">Tickets</span>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'allRequests' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('allRequests')}
                >
                  All requests
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'assignedToMe' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('assignedToMe')}
                >
                  Assigned to me
                </button>
              </div>
              <div className="admin-nav-group">
                <span className="admin-nav-group-label">Site content</span>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'notifications' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('notifications')}
                >
                  Notifications
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'departments' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('departments')}
                >
                  Departments
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'shortcuts' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('shortcuts')}
                >
                  Shortcuts
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'helpLibrary' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('helpLibrary')}
                >
                  Help library
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'contacts' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('contacts')}
                >
                  Contacts
                </button>
                <div className="admin-nav-expandable">
                  <button
                    type="button"
                    className={`admin-nav-item ${currentTab === 'settings' ? 'admin-nav-item--active' : ''}`}
                    onClick={() => {
                      setCurrentTab('settings');
                      setSettingsSectionFocus(null);
                    }}
                  >
                    Settings
                  </button>
                  {currentTab === 'settings' ? (
                    <div
                      className="admin-settings-side-tree"
                      role="navigation"
                      aria-label="Settings page sections"
                    >
                      <button
                        type="button"
                        className={`admin-settings-side-tree__link${
                          settingsSectionFocus === null ? ' admin-settings-side-tree__link--active' : ''
                        }`}
                        onClick={() => focusSettingsSection(null)}
                      >
                        All sections
                      </button>
                      <button
                        type="button"
                        className={`admin-settings-side-tree__link${
                          settingsSectionFocus === 'branding' ? ' admin-settings-side-tree__link--active' : ''
                        }`}
                        onClick={() => focusSettingsSection('branding')}
                      >
                        Branding & access
                      </button>
                      <button
                        type="button"
                        className={`admin-settings-side-tree__link${
                          settingsSectionFocus === 'motd' ? ' admin-settings-side-tree__link--active' : ''
                        }`}
                        onClick={() => focusSettingsSection('motd')}
                      >
                        Message of the day (AI)
                      </button>
                      <div className="admin-settings-side-tree__group">
                        <div className="admin-settings-side-tree__group-label">Deployment & integration</div>
                        <button
                          type="button"
                          className={`admin-settings-side-tree__link admin-settings-side-tree__link--nested${
                            settingsSectionFocus === 'deployment-overview'
                              ? ' admin-settings-side-tree__link--active'
                              : ''
                          }`}
                          onClick={() => focusSettingsSection('deployment-overview')}
                        >
                          Overview
                        </button>
                        {DEPLOYMENT_SECTION_ORDER.map((sid) => (
                          <button
                            key={sid}
                            type="button"
                            className={`admin-settings-side-tree__link admin-settings-side-tree__link--nested${
                              settingsSectionFocus === `deployment-${sid}`
                                ? ' admin-settings-side-tree__link--active'
                                : ''
                            }`}
                            onClick={() => focusSettingsSection(`deployment-${sid}`)}
                          >
                            {DEPLOYMENT_SECTION_TITLES[sid] || sid}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                {checkmkUiEnabled ? (
                  <button
                    type="button"
                    className={`admin-nav-item ${currentTab === 'checkmk' ? 'admin-nav-item--active' : ''}`}
                    onClick={() => setCurrentTab('checkmk')}
                  >
                    Checkmk down hosts
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'userChats' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('userChats')}
                >
                  User chats
                </button>
                <button
                  type="button"
                  className={`admin-nav-item ${currentTab === 'dataBackup' ? 'admin-nav-item--active' : ''}`}
                  onClick={() => setCurrentTab('dataBackup')}
                >
                  Backup & restore
                </button>
              </div>
            </nav>
          </aside>

          <main className="admin-main">
            <header className="admin-main-header">
              <h1 className="admin-page-title">{pageMeta.title}</h1>
              {pageMeta.subtitle ? <p className="admin-page-subtitle">{pageMeta.subtitle}</p> : null}
            </header>

            <div className="admin-main-scroll">
            {(error || successMessage) && (
              <div className="admin-alerts" role="region" aria-label="Status messages">
                {error && (
                  <div className="admin-alert admin-alert--error" role="alert">
                    {error}
                  </div>
                )}
                {successMessage && (
                  <div
                    key={`settings-ok-${settingsSaveFlashKey}`}
                    className="admin-alert admin-alert--success admin-alert--success-flash admin-alert--toast"
                    role="status"
                  >
                    {successMessage}
                  </div>
                )}
              </div>
            )}

            {currentTab === "allRequests" && (
        <div className="row mb-4">
          <div className="col-md-12">
            <div className="card admin-surface">
              <div className="card-header admin-card-header">
                <h3 className="title admin-card-title">Ticket list</h3>
                <div className="admin-toolbar">
                  <input
                    type="search"
                    className="form-control form-control-sm admin-search-input"
                    value={allRequestsQuery}
                    onChange={(e) => setAllRequestsQuery(e.target.value)}
                    placeholder="Search title, description, requester, assignee…"
                    aria-label="Search tickets"
                  />
                  <select
                    className="form-control form-control-sm admin-select"
                    value={assignedFilter}
                    onChange={(e) => setAssignedFilter(e.target.value)}
                    aria-label="Assignment filter"
                  >
                    <option value="all">All assignments</option>
                    <option value="assigned">Assigned only</option>
                    <option value="unassigned">Unassigned only</option>
                  </select>
                  <select
                    className="form-control form-control-sm admin-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    aria-label="Status filter"
                  >
                    <option value="all">All statuses</option>
                    <option value="pending">Pending</option>
                    <option value="in progress">In progress</option>
                    <option value="closed">Closed</option>
                  </select>
                  <select
                    className="form-control form-control-sm admin-select"
                    value={sortCriteria}
                    onChange={(e) => setSortCriteria(e.target.value)}
                    aria-label="Sort order"
                  >
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="assignedTo">By assignee</option>
                    <option value="status">By status</option>
                  </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm admin-btn-ghost"
              onClick={handleExportFilteredRequests}
              disabled={filteredRequests.length === 0}
            >
              Export CSV
            </button>
            <label className="btn btn-secondary btn-sm admin-btn-ghost mb-0" style={{ cursor: 'pointer' }}>
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={handleImportRequestsCsv}
              />
            </label>
                </div>
              </div>
              <div className="card-body">
                <div className="admin-requests-summary">
                  <span>{allRequestStats.shown} shown</span>
                  <span>{allRequestStats.total} total</span>
                  <span>{allRequestStats.pending} pending</span>
                  <span>{allRequestStats.inProgress} in progress</span>
                  <span>{allRequestStats.closed} closed</span>
                </div>
                <div className="table-header">
                  <table className="admin-users-table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Status</th>
                        <th>Department</th>
                        <th>Assigned To</th>
                        <th>Date</th>
                        <th>Created By</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                  </table>
                </div>
                <div className="table-body">
                  <table className="admin-users-table">
                    <tbody>
                      {filteredRequests.map((request) => (
                        <tr onClick={() => {
                          setSelectedRequest(request);
                          setTitle(request.title);
                          setDescription(request.description);
                          setStatus(request.status);
                          setIsViewModalOpen(true);
                        }} key={request._id} className="admin-user-row">
                          <td>
                            <div className="admin-ticket-row-title">{request.title}</div>
                            <div className="admin-ticket-row-meta">
                              {formatCreatorPreviewLine(request)}
                            </div>
                            {adminTicketDescPreview(request.description) ? (
                              <div className="admin-ticket-row-meta admin-ticket-row-meta--muted">
                                {adminTicketDescPreview(request.description)}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <span
                              className={`admin-status-pill ${adminTicketStatusClass(request.status)}`}
                            >
                              {request.status}
                            </span>
                          </td>
                          <td>{request.department || "Not selected"}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="admin-assigned-cell">
                              <span className="admin-assigned-cell__label">
                                {request.assignedTo
                                  ? request.assignedToDisplayName || request.assignedTo || 'Unknown'
                                  : 'Unassigned'}
                              </span>
                              {user ? (
                                <button
                                  type="button"
                                  className={`admin-assign-me-btn${
                                    normSam(request.assignedTo) === normSam(user.username)
                                      ? ' admin-assign-me-btn--active'
                                      : ''
                                  }`}
                                  title={
                                    normSam(request.assignedTo) === normSam(user.username)
                                      ? 'Already assigned to you'
                                      : 'Assign to me'
                                  }
                                  aria-label="Assign to me"
                                  disabled={
                                    assigningTicketId === request._id ||
                                    normSam(request.assignedTo) === normSam(user.username)
                                  }
                                  onClick={(ev) => handleAssignToMe(request, ev)}
                                >
                                  {assigningTicketId === request._id ? '…' : '👤'}
                                </button>
                              ) : null}
                            </div>
                          </td>
                          <td>{formatDate(request.createdAt)}</td>
                          <td title={formatCreatorTooltip(request)}>
                            {formatCreatorTableCell(request)}
                          </td>
                          <td>
      {/* Edit Icon */}
      <span
        className="action-icon admin-action-icon"
        onClick={(e) => {
          e.stopPropagation();
          setSelectedRequest(request);
          setTitle(request.title);
          setDescription(request.description);
          const st = formStateFromTicket(request);
          setPhoneKind(st.phoneKind);
          setPhoneNumber(st.phoneNumber);
          setDepartment(request.department || '');
          setStatus(request.status);
          setIsEditModalOpen(true);
          setAssignedTo(request.assignedTo || "");
        }}
        role="img"
        aria-label="Edit"
        title="Edit Request"
      >
        ✏️
      </span>

      {/* Add Comment Icon */}
      <span
        className="action-icon admin-action-icon"
        onClick={(e) => {
          e.stopPropagation();
          setSelectedRequest(request);
          setTitle(request.title);
          setDescription(request.description);
          setStatus(request.status);
          setIsCommentModalOpen(true);
        }}
        role="img"
         aria-label="Add Comment"
         title="Add Comment" 
      >
        💬
      </span>

      {/* Delete Icon */}
      <span
        className="action-icon admin-action-icon"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm('Are you sure you want to delete this request?')) {
            handleDeleteRequest(request._id);
          }
        }}
        role="img"
        title="Delete Request" 
        aria-label="Delete"
      >
        ❌
      </span>
    
 
</td>
                        </tr>
                      ))}
                      {filteredRequests.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="admin-empty-row">
                            No tickets match the current filters.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
{currentTab === 'assignedToMe' && (
  <div className="row mb-4">
    <div className="col-md-12">
      <div className="card admin-surface">
        <div className="card-header admin-card-header">
          <h3 className="title admin-card-title">Your queue</h3>
          <div className="admin-toolbar admin-toolbar--compact">
            <label className="admin-field-label" htmlFor="admin-assigned-status">Status</label>
            <select
              id="admin-assigned-status"
              className="form-control form-control-sm admin-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="in progress">In progress</option>
              <option value="closed">Closed</option>
            </select>
          </div>
        </div>
        <div className="card-body admin-assigned-list">
          <ul className="admin-assigned-ul">
            {requests
              .filter(request => {
                const assignedTo = request.assignedTo || '';
                const userId = user.username || '';
                const assignedToCheck = normSam(assignedTo) === normSam(userId);
                const statusCheck = statusFilter === "all" || request.status === statusFilter;
                return assignedToCheck && statusCheck;
              })
              .map(request => (
                <li key={request._id} className="list-item admin-assigned-card">
                  <h5 className="card-title">{request.title}</h5>
                  <small className="date" title={formatCreatorTooltip(request)}>
                    From: {formatCreatorTableCell(request)}
                    {' · '}Created: {formatDate(request.createdAt)}
                  </small>
                  <p className="description">
                    <span className="admin-ticket-row-meta d-block mb-1">
                      {formatCreatorPreviewLine(request)}
                    </span>
                    {request.description && request.description.length > 80
                      ? `${request.description.slice(0, 80)}…`
                      : request.description || '—'}
                  </p>
                  <div className="button-group admin-button-group">
                    <button type="button" className="btn btn-secondary admin-btn-ghost" onClick={() => {
                      setSelectedRequest(request);
                      setTitle(request.title);
                      setDescription(request.description);
                      setStatus(request.status);
                      setIsViewModalOpen(true);
                      setCommentText('');
                    }}>
                      View
                    </button>
                    <button type="button" className="btn btn-secondary admin-btn-ghost" onClick={() => {
                      setSelectedRequest(request);
                      setTitle(request.title);
                      setDescription(request.description);
                      const st = formStateFromTicket(request);
                      setPhoneKind(st.phoneKind);
                      setPhoneNumber(st.phoneNumber);
                      setDepartment(request.department || '');
                      setStatus(request.status);
                      setIsEditModalOpen(true);
                      setCommentText('');
                      setAssignedTo(request.assignedTo || '');
                    }}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-secondary admin-btn-ghost" onClick={() => {
                      setSelectedRequest(request);
                      setTitle(request.title);
                      setDescription(request.description);
                      setStatus(request.status);
                      setIsCommentModalOpen(true);
                      setCommentText('');
                    }}>
                      Add Comment
                    </button>
                    <button type="button" className="btn btn-danger admin-btn-danger" onClick={(e) => {
          e.stopPropagation();
          if (window.confirm('Are you sure you want to delete this request?')) {
            handleDeleteRequest(request._id);
          }
        }}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  </div>
)}
            {/* Notifications Tab */}
            {currentTab === 'notifications' && (
                <div className="row mb-4">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Notification list</h3>
                                <div className="admin-toolbar admin-toolbar--wrap">
                                  <input
                                    type="search"
                                    className="form-control form-control-sm admin-search-input"
                                    placeholder="Filter by title or description…"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    aria-label="Filter notifications"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                    onClick={() => {
                                      setEditingNotificationId(null);
                                      setNotificationTitle('');
                                      setNotificationDescription('');
                                      setNotificationIcon('📢');
                                      setNotificationLink('');
                                      setIsModalOpen(true);
                                    }}
                                  >
                                    Add notification
                                  </button>
                                </div>
                            </div>
                            <div className="card-body">
                        
                
  <div className="table-header">
  <table className="admin-users-table">
    <thead>
      <tr>
        <th>Title</th>
        <th>Description</th>
        <th>Icon</th>
        <th>Link</th>
        <th>Actions</th>
      </tr>
    </thead>
  </table>
</div>

<div className="table-body table-body-notifications">
  <table className="admin-users-table">
    <tbody className="admin-users-table">
{notifications
        .filter((notification) => {
          const term = searchTerm.toLowerCase(); 
          return (
            notification.title.toLowerCase().includes(term) ||
            notification.description.toLowerCase().includes(term)
          );
        })
        .map((notification) => (
          <tr key={notification._id} className="admin-user-row">
            <td>{notification.title}</td>
            <td>{notification.description}</td>
            <td>{notification.icon || "–"}</td>
            <td>
              {notification.link ? (
                <a
                  href={notification.link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {notification.link}
                </a>
              ) : (
                "–"
              )}
            </td>
            <td>
              <button
                type="button"
                className={`btn ${notification.isVisible ? 'btn-success' : 'btn-warning'}`}
                onClick={() => handleUpdateNotificationVisibility(notification._id, !notification.isVisible)}
              >
                {notification.isVisible ? 'Visible' : 'Hidden'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm ms-2"
                onClick={() => {
                  setEditingNotificationId(notification._id);
                  setNotificationTitle(notification.title || '');
                  setNotificationDescription(notification.description || '');
                  setNotificationIcon(notification.icon || '📢');
                  setNotificationLink(notification.link ? String(notification.link) : '');
                  setIsModalOpen(true);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-danger ms-2"
                onClick={() => {
                  handleDeleteNotification(notification._id);
                }}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
    </tbody>
  </table>
</div>
</div>
      </div>
                            </div>
                        </div>
              
            )}
 {currentTab === 'departments' && (
                <div className="row mb-4">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Departments</h3>
                            </div>
                            <div className="card-body">
                                <div className="form-group">
                                    <label className="admin-field-label d-block mb-1">Department name</label>
                                    <input
                                        type="text"
                                        className="form-control"
                                        value={departmentName}
                                        onChange={(e) => setDepartmentName(e.target.value)}
                                        placeholder="Add department"
                                    />
                                </div>
                                <button
                                    type="button"
                                    className="btn btn-secondary mb-3"
                                    onClick={handleSaveDepartment}
                                    disabled={!departmentName.trim()}
                                >
                                    Add Department
                                </button>
                                <div className="table-body-srvers table-body">
                                    <table className="admin-users-table">
                                        <thead>
                                            <tr>
                                                <th>Name</th>
                                                <th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="admin-users-table">
                                            {departments.map(item => (
                                                <tr key={item._id}>
                                                    <td>{item.name}</td>
                                                    <td>
                                                        <button
                                                            type="button"
                                                            className="btn btn-danger"
                                                            onClick={() => handleDeleteDepartment(item._id)}
                                                        >
                                                            Delete
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {currentTab === 'shortcuts' && (
                <div className="row mb-4">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Shortcut links (home grid)</h3>
                            </div>
                            <div className="card-body">
                                <p className="admin-help-text mb-3">
                                    Shortcut tiles on the home page quick-links panel. Defaults load on first run; you can edit or remove any row.
                                    CSV import: only Title and URL are required. Optional columns Description, Category, ImgSrc, Alt, Sort Order, and Admin Only (true/false) can be omitted or left blank.
                                </p>
                                <div className="admin-toolbar mb-3">
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                        onClick={() => {
                                            resetShortcutForm();
                                            setShortcutModalOpen(true);
                                        }}
                                    >
                                        Add shortcut
                                    </button>
                                    <button type="button" className="btn btn-secondary btn-sm admin-btn-ghost" onClick={handleExportShortcutsCsv}>
                                        Export CSV
                                    </button>
                                    <label className="btn btn-secondary btn-sm admin-btn-ghost mb-0" style={{ cursor: 'pointer' }}>
                                        Import CSV
                                        <input
                                            type="file"
                                            accept=".csv,text/csv"
                                            hidden
                                            onChange={handleImportShortcutsCsv}
                                        />
                                    </label>
                                    <input
                                        type="search"
                                        className="form-control form-control-sm admin-shortcuts-search"
                                        placeholder="Search title, URL, category…"
                                        value={shortcutSearchQuery}
                                        onChange={(e) => setShortcutSearchQuery(e.target.value)}
                                        aria-label="Filter shortcuts"
                                    />
                                </div>
                                <div className="table-body-srvers table-body">
                                    <table className="admin-users-table">
                                        <thead>
                                            <tr>
                                                <th>Title</th>
                                                <th>URL</th>
                                                <th>Category</th>
                                                <th>Admin only</th>
                                                <th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {shortcutsList.length === 0 && (
                                                <tr>
                                                    <td colSpan={5} className="text-muted">
                                                        No shortcuts yet. Click Add shortcut.
                                                    </td>
                                                </tr>
                                            )}
                                            {shortcutsList.length > 0 && filteredShortcutsList.length === 0 && (
                                                <tr>
                                                    <td colSpan={5} className="text-muted">
                                                        No shortcuts match “{shortcutSearchQuery.trim()}”.
                                                    </td>
                                                </tr>
                                            )}
                                            {filteredShortcutsList.map((s) => (
                                                <tr key={s._id}>
                                                    <td>{s.title}</td>
                                                    <td style={{ maxWidth: '280px', wordBreak: 'break-all', textAlign: 'left' }}>{s.url}</td>
                                                    <td>{s.category}</td>
                                                    <td>{s.adminOnly ? 'Yes' : '—'}</td>
                                                    <td>
                                                        <button
                                                            type="button"
                                                            className="btn btn-secondary btn-sm me-1"
                                                            onClick={() => {
                                                                setEditingShortcutId(s._id);
                                                                setScTitle(s.title);
                                                                setScDesc(s.description || '');
                                                                setScUrl(s.url);
                                                                setScCategory(s.category || 'General');
                                                                setScImg(s.imgSrc || '');
                                                                setScSort(s.sortOrder ?? 0);
                                                                setScAdminOnly(Boolean(s.adminOnly));
                                                                setScUseFaviconFromUrl(false);
                                                                setScSummary(s.summary || '');
                                                                setScUseCases(
                                                                    Array.isArray(s.useCases)
                                                                        ? s.useCases.map((x) => String(x || ''))
                                                                        : [],
                                                                );
                                                                setScExamples(
                                                                    Array.isArray(s.examples)
                                                                        ? s.examples.map((ex) => ({
                                                                              title: String((ex && ex.title) || ''),
                                                                              body: String((ex && ex.body) || ''),
                                                                          }))
                                                                        : [],
                                                                );
                                                                setShortcutModalError('');
                                                                setShortcutModalOpen(true);
                                                            }}
                                                        >
                                                            Edit
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn btn-danger btn-sm"
                                                            onClick={() => handleDeleteShortcut(s._id)}
                                                        >
                                                            Remove
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {currentTab === 'helpLibrary' && (
                <div className="row mb-4">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Help library man-pages</h3>
                            </div>
                            <div className="card-body">
                                <p className="admin-help-text mb-3">
                                    The public Help library shows every shortcut as an app tile. Each row below corresponds to an app —
                                    edit its man-page (summary, use cases, examples) shown when users open the tile. Apps without any
                                    content still render, but with empty sections hidden.
                                </p>
                                <div className="admin-toolbar mb-3">
                                    <input
                                        type="search"
                                        className="form-control form-control-sm admin-shortcuts-search"
                                        placeholder="Search title, category, summary, use cases, examples…"
                                        value={helpLibSearchQuery}
                                        onChange={(e) => setHelpLibSearchQuery(e.target.value)}
                                        aria-label="Filter help library"
                                    />
                                </div>
                                <div className="table-body-srvers table-body">
                                    <table className="admin-users-table">
                                        <thead>
                                            <tr>
                                                <th>App</th>
                                                <th>Category</th>
                                                <th>Summary</th>
                                                <th>Use cases</th>
                                                <th>Examples</th>
                                                <th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {shortcutsList.length === 0 && (
                                                <tr>
                                                    <td colSpan={6} className="text-muted">
                                                        No apps yet. Add one in the Shortcuts tab first.
                                                    </td>
                                                </tr>
                                            )}
                                            {shortcutsList.length > 0 && filteredHelpLibList.length === 0 && (
                                                <tr>
                                                    <td colSpan={6} className="text-muted">
                                                        No apps match “{helpLibSearchQuery.trim()}”.
                                                    </td>
                                                </tr>
                                            )}
                                            {filteredHelpLibList.map((s) => {
                                                const summaryStr = String(s.summary || '').trim();
                                                const useCasesArr = Array.isArray(s.useCases) ? s.useCases : [];
                                                const examplesArr = Array.isArray(s.examples) ? s.examples : [];
                                                const summaryPreview = summaryStr
                                                    ? (summaryStr.length > 90 ? `${summaryStr.slice(0, 90).trim()}…` : summaryStr)
                                                    : '—';
                                                const isEmpty = !summaryStr && useCasesArr.length === 0 && examplesArr.length === 0;
                                                return (
                                                    <tr key={s._id}>
                                                        <td>
                                                            <div className="admin-helplib-app">
                                                                {s.imgSrc ? (
                                                                    <img
                                                                        src={s.imgSrc}
                                                                        alt=""
                                                                        className="admin-helplib-app__logo"
                                                                        onError={(e) => {
                                                                            e.currentTarget.style.display = 'none';
                                                                        }}
                                                                    />
                                                                ) : null}
                                                                <span>
                                                                    <strong style={{ display: 'block' }}>{s.title || 'Untitled app'}</strong>
                                                                    {isEmpty ? (
                                                                        <span className="admin-helplib-app__badge">No content</span>
                                                                    ) : null}
                                                                </span>
                                                            </div>
                                                        </td>
                                                        <td>{s.category || '—'}</td>
                                                        <td style={{ maxWidth: '320px', textAlign: 'left' }}>
                                                            {summaryPreview}
                                                        </td>
                                                        <td>{useCasesArr.length}</td>
                                                        <td>{examplesArr.length}</td>
                                                        <td>
                                                            <button
                                                                type="button"
                                                                className="btn btn-secondary btn-sm me-1"
                                                                onClick={() => openManPageEditor(s)}
                                                            >
                                                                Edit man-page
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn btn-danger btn-sm"
                                                                onClick={() => handleDeleteShortcut(s._id)}
                                                            >
                                                                Delete
                                                            </button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {currentTab === 'contacts' && (
                <div className="row mb-4">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Contact page</h3>
                            </div>
                            <div className="card-body admin-settings-body">
                                <p className="admin-help-text mb-3">
                                  Order top-to-bottom matches the public Contact page. Use the arrows to reorder; save when done.
                                </p>
                                <table className="admin-users-table">
                                    <thead>
                                        <tr>
                                            <th scope="col" className="admin-contacts-th-order">
                                              Order
                                            </th>
                                            <th scope="col">Number</th>
                                            <th scope="col">Title</th>
                                            <th scope="col">Name</th>
                                            <th scope="col" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {contactsList.map((row, index) => (
                                            <tr key={row._rowKey}>
                                                <td className="admin-contacts-td-order">
                                                    <div
                                                        className="admin-contacts-order-btns"
                                                        role="group"
                                                        aria-label="Reorder contact row"
                                                    >
                                                        <button
                                                            type="button"
                                                            className="btn btn-secondary btn-sm admin-btn-ghost"
                                                            disabled={index === 0}
                                                            aria-label="Move row up"
                                                            onClick={() => moveContactRow(index, -1)}
                                                        >
                                                            ↑
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn btn-secondary btn-sm admin-btn-ghost"
                                                            disabled={index === contactsList.length - 1}
                                                            aria-label="Move row down"
                                                            onClick={() => moveContactRow(index, 1)}
                                                        >
                                                            ↓
                                                        </button>
                                                    </div>
                                                </td>
                                                <td>
                                                    <input
                                                        className="form-control"
                                                        value={row.title}
                                                        onChange={(e) => {
                                                            const next = [...contactsList];
                                                            next[index] = { ...row, title: e.target.value };
                                                            setContactsList(next);
                                                        }}
                                                    />
                                                </td>
                                                <td>
                                                    <input
                                                        className="form-control"
                                                        value={row.phone}
                                                        onChange={(e) => {
                                                            const next = [...contactsList];
                                                            next[index] = { ...row, phone: e.target.value };
                                                            setContactsList(next);
                                                        }}
                                                    />
                                                </td>
                                                <td>
                                                    <input
                                                        className="form-control"
                                                        value={row.name}
                                                        onChange={(e) => {
                                                            const next = [...contactsList];
                                                            next[index] = { ...row, name: e.target.value };
                                                            setContactsList(next);
                                                        }}
                                                    />
                                                </td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="btn btn-danger btn-sm"
                                                        onClick={() => setContactsList(contactsList.filter((_, i) => i !== index))}
                                                    >
                                                        Remove
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm admin-btn-primary-soft mt-2"
                                    onClick={() =>
                                        setContactsList([
                                            ...contactsList,
                                            {
                                                name: '',
                                                phone: '',
                                                title: '',
                                                _rowKey: adminContactRowKey(),
                                            },
                                        ])
                                    }
                                >
                                    Add row
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary mt-2 admin-btn-primary-soft"
                                    onClick={handleSaveContacts}
                                >
                                    Save contacts
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

 {currentTab === 'settings' && (
              <>
                {(settingsSectionFocus === null || settingsSectionFocus === 'branding') && (
                <div className="row mb-4" id="admin-settings-section-branding">
                    <div className="col-md-12">
                        <div className="card admin-surface">
                            <div className="card-header admin-card-header">
                                <h3 className="title admin-card-title">Branding & access</h3>
                            </div>
                            <div className="card-body admin-settings-body">
                                <p className="admin-help-text mb-4">
                                  Header visuals (logo, favicon). Chat tab visibility is under{' '}
                                  <strong>Deployment → Chat &amp; retention</strong>.{' '}
                                  <AdminRequiredStar /> Required for applying logo / favicon via <strong>Save</strong> (upload
                                  is optional—you can paste a URL or path instead).
                                </p>

                                <div className="admin-settings-field-list">
                                  <section className="admin-settings-field-section">
                                    <h4 className="admin-settings-field-section__title">Header logo</h4>
                                    <div className="admin-settings-field-row">
                                      <label className="admin-settings-field-row__label" htmlFor="admin-branding-logo-upload">
                                        Upload file
                                      </label>
                                      <div className="admin-settings-field-row__control">
                                        <input
                                          id="admin-branding-logo-upload"
                                          type="file"
                                          className="form-control"
                                          accept="image/jpeg,image/png,image/gif,image/webp"
                                          aria-label="Upload logo image file"
                                          onChange={async (e) => {
                                            const file = e.target.files && e.target.files[0];
                                            e.target.value = '';
                                            if (!file) return;
                                            try {
                                              setError('');
                                              const url = await uploadAdminImage(file);
                                              setLogoUrl(url);
                                              flashSettingsSuccess('Logo file uploaded. Click Save Logo to apply.');
                                            } catch (err) {
                                              setError(err.message || 'Upload failed');
                                            }
                                          }}
                                        />
                                      </div>
                                    </div>
                                    <div className="admin-settings-field-row">
                                      <label className="admin-settings-field-row__label" htmlFor="admin-branding-logo-url">
                                        URL or path
                                        <AdminRequiredStar />
                                      </label>
                                      <div className="admin-settings-field-row__control">
                                        <input
                                          id="admin-branding-logo-url"
                                          type="text"
                                          className="form-control"
                                          value={logoUrl}
                                          onChange={(e) => setLogoUrl(e.target.value)}
                                          placeholder="logo192.png, /api/uploads/files/…, or https://…"
                                        />
                                      </div>
                                    </div>
                                    {logoUrl ? (
                                      <div className="admin-settings-field-row admin-settings-field-row--preview">
                                        <span className="admin-settings-field-row__label">Preview</span>
                                        <div className="admin-settings-field-row__control">
                                          <img src={logoUrl} alt="Logo preview" className="settings-logo-preview" />
                                        </div>
                                      </div>
                                    ) : null}
                                    <div className="admin-settings-field-row admin-settings-field-row--actions pt-2">
                                      <span className="admin-settings-field-row__label sr-only">Save</span>
                                      <div className="admin-settings-field-row__control">
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={handleSaveLogo}
                                          disabled={!logoUrl.trim()}
                                        >
                                          Save logo
                                        </button>
                                      </div>
                                    </div>
                                  </section>

                                  <section className="admin-settings-field-section">
                                    <h4 className="admin-settings-field-section__title">Favicon</h4>
                                    <div className="admin-settings-field-row">
                                      <label className="admin-settings-field-row__label" htmlFor="admin-branding-favicon-upload">
                                        Upload file
                                      </label>
                                      <div className="admin-settings-field-row__control">
                                        <input
                                          id="admin-branding-favicon-upload"
                                          type="file"
                                          className="form-control"
                                          accept="image/jpeg,image/png,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico"
                                          aria-label="Upload favicon file"
                                          onChange={async (e) => {
                                            const file = e.target.files && e.target.files[0];
                                            e.target.value = '';
                                            if (!file) return;
                                            try {
                                              setError('');
                                              const url = await uploadAdminImage(file);
                                              setFaviconUrl(url);
                                              flashSettingsSuccess('Favicon file uploaded. Click Save Favicon to apply.');
                                            } catch (err) {
                                              setError(err.message || 'Upload failed');
                                            }
                                          }}
                                        />
                                      </div>
                                    </div>
                                    <div className="admin-settings-field-row">
                                      <label className="admin-settings-field-row__label" htmlFor="admin-branding-favicon-url">
                                        URL or path
                                        <AdminRequiredStar />
                                      </label>
                                      <div className="admin-settings-field-row__control">
                                        <input
                                          id="admin-branding-favicon-url"
                                          type="text"
                                          className="form-control"
                                          value={faviconUrl}
                                          onChange={(e) => setFaviconUrl(e.target.value)}
                                          placeholder="images/favicon.png, /api/uploads/files/…, or https://…"
                                        />
                                      </div>
                                    </div>
                                    {faviconUrl ? (
                                      <div className="admin-settings-field-row admin-settings-field-row--preview">
                                        <span className="admin-settings-field-row__label">Preview</span>
                                        <div className="admin-settings-field-row__control">
                                          <img
                                            src={faviconUrl}
                                            alt="Favicon preview"
                                            className="settings-logo-preview"
                                            style={{ width: 32, height: 32, objectFit: 'contain' }}
                                          />
                                        </div>
                                      </div>
                                    ) : null}
                                    <div className="admin-settings-field-row admin-settings-field-row--actions pt-2">
                                      <span className="admin-settings-field-row__label sr-only">Save</span>
                                      <div className="admin-settings-field-row__control">
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={handleSaveFavicon}
                                          disabled={!faviconUrl.trim()}
                                        >
                                          Save favicon
                                        </button>
                                      </div>
                                    </div>
                                  </section>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                )}

                {(settingsSectionFocus === null || settingsSectionFocus === 'motd') && (
                <div className="row mb-4" id="admin-settings-section-motd">
                  <div className="col-md-12">
                    <div className="card admin-surface">
                      <div className="card-header admin-card-header">
                        <h3 className="title admin-card-title">Message of the day (Ollama)</h3>
                      </div>
                      <div className="card-body admin-settings-body">
                        <p className="admin-help-text mb-3">
                          Shows on the home page in a dedicated sidebar widget. The server calls
                          your Ollama <code>/api/generate</code> endpoint, caches the text, and refreshes in the background
                          once per day after the configured time (server clock). Default URL{' '}
                          <code>http://127.0.0.1:11434</code> — use a reachable host
                          from the app container (e.g. <code>host.docker.internal</code> on Docker Desktop).
                          When the widget is enabled, fields marked{' '}
                          <span className="admin-required-legend-inline">*</span> must be filled for generation and caching to
                          work.
                        </p>
                        {motdLoadError ? <p className="text-danger mb-2">{motdLoadError}</p> : null}
                        {!motdForm && !motdLoadError ? (
                          <p className="admin-help-text mb-0">Loading…</p>
                        ) : null}
                        {motdForm ? (
                          <div className="admin-settings-field-list">
                            <section className="admin-settings-field-section">
                              <h4 className="admin-settings-field-section__title">Widget</h4>
                              <div className="admin-settings-field-row admin-settings-field-row--stack">
                                <div className="admin-settings-field-row__control admin-settings-field-row__control--wide">
                                  <AdminSettingsToggle
                                    checked={!!motdForm.enabled}
                                    onChange={(v) =>
                                      setMotdForm((prev) => (prev ? { ...prev, enabled: v } : prev))
                                    }
                                  >
                                    <span>Enable message of the day on the home page</span>
                                  </AdminSettingsToggle>
                                </div>
                              </div>
                              <div className="admin-settings-field-row">
                                <label className="admin-settings-field-row__label" htmlFor="admin-motd-title">
                                  Title
                                  {motdForm.enabled ? <AdminRequiredStar /> : null}
                                </label>
                                <div className="admin-settings-field-row__control">
                                  <input
                                    id="admin-motd-title"
                                    type="text"
                                    className="form-control"
                                    maxLength={100}
                                    value={motdForm.title || ''}
                                    onChange={(e) =>
                                      setMotdForm((prev) => (prev ? { ...prev, title: e.target.value } : prev))
                                    }
                                  />
                                </div>
                              </div>
                            </section>

                            <section className="admin-settings-field-section">
                              <h4 className="admin-settings-field-section__title">Ollama</h4>
                              <div className="admin-settings-field-row admin-settings-field-row--stack">
                                <label className="admin-settings-field-row__label" htmlFor="admin-motd-prompt">
                                  Prompt
                                  {motdForm.enabled ? <AdminRequiredStar /> : null}
                                </label>
                                <div className="admin-settings-field-row__control admin-settings-field-row__control--wide">
                                  <textarea
                                    id="admin-motd-prompt"
                                    className="form-control"
                                    rows={4}
                                    value={motdForm.aiPrompt || ''}
                                    onChange={(e) =>
                                      setMotdForm((prev) => (prev ? { ...prev, aiPrompt: e.target.value } : prev))
                                    }
                                    placeholder="Describe tone, audience, length, and topics…"
                                  />
                                </div>
                              </div>
                              <div className="admin-settings-field-row">
                                <label className="admin-settings-field-row__label" htmlFor="admin-motd-ollama-url">
                                  Base URL
                                  {motdForm.enabled ? <AdminRequiredStar /> : null}
                                  <span className="admin-settings-field-row__docker-env">OLLAMA_URL</span>
                                </label>
                                <div className="admin-settings-field-row__control">
                                  <input
                                    id="admin-motd-ollama-url"
                                    type="text"
                                    className="form-control"
                                    value={motdForm.ollamaUrl || ''}
                                    onChange={(e) =>
                                      setMotdForm((prev) => (prev ? { ...prev, ollamaUrl: e.target.value } : prev))
                                    }
                                    placeholder="http://127.0.0.1:11434"
                                  />
                                </div>
                              </div>
                              <div className="admin-settings-field-row">
                                <label className="admin-settings-field-row__label" htmlFor="admin-motd-model">
                                  Model
                                  {motdForm.enabled ? <AdminRequiredStar /> : null}
                                  <span className="admin-settings-field-row__docker-env">OLLAMA_MODEL</span>
                                </label>
                                <div className="admin-settings-field-row__control">
                                  <input
                                    id="admin-motd-model"
                                    type="text"
                                    className="form-control"
                                    value={motdForm.ollamaModel || ''}
                                    onChange={(e) =>
                                      setMotdForm((prev) => (prev ? { ...prev, ollamaModel: e.target.value } : prev))
                                    }
                                    placeholder="llama3.2"
                                  />
                                </div>
                              </div>
                              <div className="admin-settings-field-row admin-settings-field-row--stack">
                                <label className="admin-settings-field-row__label" htmlFor="admin-motd-regen-at">
                                  Regenerate daily after
                                  {motdForm.enabled ? <AdminRequiredStar /> : null}
                                </label>
                                <div className="admin-settings-field-row__control admin-settings-field-row__control--wide">
                                  <input
                                    id="admin-motd-regen-at"
                                    type="time"
                                    className="form-control"
                                    style={{ maxWidth: 200 }}
                                    value={
                                      typeof motdForm.regenerateAt === 'string' &&
                                      /^\d{2}:\d{2}$/.test(motdForm.regenerateAt)
                                        ? motdForm.regenerateAt
                                        : '08:00'
                                    }
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setMotdForm((prev) =>
                                        prev ? { ...prev, regenerateAt: v || '08:00' } : prev,
                                      );
                                    }}
                                  />
                                  <span className="admin-help-text small d-block mt-2">
                                    Server local clock. Once this time has passed, the next MOTD request can refresh the
                                    cache in the background.
                                  </span>
                                </div>
                              </div>
                            </section>

                            <section className="admin-settings-field-section">
                              <p className="admin-help-text small mb-3">
                                <strong>Last cached:</strong>{' '}
                                {motdForm.cachedAt ? formatDateTime(motdForm.cachedAt) : '—'}
                              </p>
                              {motdForm.lastError ? (
                                <p className="text-warning small mb-3">
                                  <strong>Last error:</strong> {motdForm.lastError}
                                </p>
                              ) : null}
                              <div className="d-flex flex-wrap gap-2 align-items-center">
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                  disabled={motdSaveBusy}
                                  onClick={handleSaveMotd}
                                >
                                  {motdSaveBusy ? 'Saving…' : 'Save MOTD settings'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm admin-btn-ghost"
                                  disabled={motdRegenBusy || !motdForm.aiPrompt?.trim()}
                                  onClick={handleRegenerateMotd}
                                  title="Calls Ollama now and updates the cached message"
                                >
                                  {motdRegenBusy ? 'Generating…' : 'Regenerate now'}
                                </button>
                              </div>
                            </section>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {(settingsSectionFocus === null || settingsSectionFocus === 'deployment-overview') && (
                <div className="row mb-3" id="admin-settings-section-deployment-overview">
                  <div className="col-md-12">
                    <div className="card admin-surface admin-deployment-subsection-card">
                      <div className="card-header admin-card-header">
                        <h3 className="title admin-card-title mb-0">Deployment & integration</h3>
                      </div>
                      <div className="card-body admin-settings-body">
                        <p className="admin-help-text mb-3">
                          {deploymentPrecedence ||
                            'Values saved in each subsection below override Docker / host environment for the same key (except LOCAL_ADMIN_* when bootstrapped from compose). JWT secret and trust proxy stay in compose only.'}
                        </p>
                        <p className="admin-help-text small mb-0 text-muted">
                          Use the subsection links in the sidebar to jump directly to Chat, LDAP, Keycloak, and other areas.
                          Required fields in each card are labelled with{' '}
                          <AdminRequiredStar /> Keycloak-labelled fields apply when SSO is enabled.
                        </p>
                        {deploymentLoadError ? (
                          <p className="text-danger mb-0 mt-3">{deploymentLoadError}</p>
                        ) : null}
                        {!deploymentSections && !deploymentLoadError ? (
                          <p className="admin-help-text mb-0 mt-3">Loading deployment settings…</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {settingsSectionFocus &&
                  settingsSectionFocus.startsWith('deployment-') &&
                  settingsSectionFocus !== 'deployment-overview' &&
                  !deploymentSections && (
                    <div className="row mb-4">
                      <div className="col-md-12">
                        {deploymentLoadError ? (
                          <p className="text-danger mb-0">{deploymentLoadError}</p>
                        ) : (
                          <p className="admin-help-text mb-0">Loading deployment settings…</p>
                        )}
                      </div>
                    </div>
                  )}

                {deploymentSections
                  ? DEPLOYMENT_SECTION_ORDER.filter((sid) => deploymentSections[sid])
                      .filter(
                        (sectionId) =>
                          settingsSectionFocus === null ||
                          settingsSectionFocus === `deployment-${sectionId}`,
                      )
                      .map((sectionId) => (
                      <div
                        className="row mb-4"
                        key={sectionId}
                        id={`admin-settings-section-deployment-${sectionId}`}
                      >
                        <div className="col-md-12">
                          <div className="card admin-surface admin-deployment-subsection-card">
                            <div className="card-header admin-card-header">
                              <h3 className="title admin-card-title mb-0">
                                {DEPLOYMENT_SECTION_TITLES[sectionId] || sectionId}
                              </h3>
                            </div>
                            <div className="card-body admin-settings-body">
                              {DEPLOYMENT_SECTION_INTRO[sectionId] ? (
                                <p className="admin-help-text mb-4">{DEPLOYMENT_SECTION_INTRO[sectionId]}</p>
                              ) : null}
                              <div className="admin-settings-field-list">
                                {sectionId === 'chat' ? (
                                  <section className="admin-settings-field-section">
                                    <h4 className="admin-settings-field-section__title">Homepage Chat tab</h4>
                                    <div className="admin-settings-field-row admin-settings-field-row--stack">
                                      <div className="admin-settings-field-row__control admin-settings-field-row__control--wide">
                                        <AdminSettingsToggle
                                          checked={lobbyChatEnabled}
                                          onChange={handleLobbyChatToggle}
                                          disabled={lobbySaveBusy}
                                        >
                                          <>
                                            <span className="d-block">Enable Chat in the main menu</span>
                                            <span className="d-block text-muted small mt-1" style={{ maxWidth: 640 }}>
                                              When enabled, users see the <strong>Chat</strong> tab (Everyone, DMs, group chats for
                                              admins). Retention uses <code>CHAT_RETENTION_DAYS</code> below (or compose /{' '}
                                              <code>.env</code>). To force-hide Chat from the server, set{' '}
                                              <code>LOBBY_CHAT_UI=false</code> in Docker / host environment (this subsection only
                                              stores the in-app toggle and retention fields).
                                            </span>
                                          </>
                                        </AdminSettingsToggle>
                                      </div>
                                    </div>
                                  </section>
                                ) : null}
                                {sectionId === 'ldap'
                                  ? LDAP_FIELD_GROUPS.map((group) => {
                                      const keys = group.keys.filter((k) =>
                                        Object.prototype.hasOwnProperty.call(
                                          deploymentSections[sectionId],
                                          k,
                                        ),
                                      );
                                      if (keys.length === 0) return null;
                                      return (
                                        <div key={group.title} className="admin-settings-field-section">
                                          <h4 className="admin-settings-field-section__title">{group.title}</h4>
                                          {keys.map((fieldKey) => (
                                            <DeploymentEnvFieldRow
                                              key={fieldKey}
                                              sectionId={sectionId}
                                              fieldKey={fieldKey}
                                              value={deploymentSections[sectionId][fieldKey]}
                                              setDeploymentSections={setDeploymentSections}
                                              sectionBlock={deploymentSections[sectionId]}
                                            />
                                          ))}
                                        </div>
                                      );
                                    })
                                  : deploymentFieldKeysForSection(
                                      sectionId,
                                      deploymentSections[sectionId],
                                    )
                                      .filter(
                                        (fieldKey) =>
                                          !(sectionId === 'chat' && fieldKey === 'LOBBY_CHAT_UI'),
                                      )
                                      .map((fieldKey) => (
                                      <DeploymentEnvFieldRow
                                        key={fieldKey}
                                        sectionId={sectionId}
                                        fieldKey={fieldKey}
                                        value={deploymentSections[sectionId][fieldKey]}
                                        setDeploymentSections={setDeploymentSections}
                                        sectionBlock={deploymentSections[sectionId]}
                                      />
                                    ))}
                                {sectionId === 'pinger' ? (
                                  <>
                                    <section className="admin-settings-field-section">
                                      <h4 className="admin-settings-field-section__title">In-browser SSH</h4>
                                      <p className="admin-help-text small mb-2">
                                        Traffic is proxied through this app: users enter the <strong>remote</strong> SSH username
                                        and password. Idle sessions close after no keystrokes or terminal output. Optional:{' '}
                                        <code>PINGER_SSH_PORT</code> in the environment when SSH is not on port 22.
                                      </p>
                                      <div className="admin-settings-field-row">
                                        <label
                                          className="admin-settings-field-row__label"
                                          htmlFor="admin-pinger-ssh-idle"
                                        >
                                          Idle timeout (minutes)
                                        </label>
                                        <div className="admin-settings-field-row__control d-flex gap-2 align-items-center flex-wrap">
                                          <input
                                            id="admin-pinger-ssh-idle"
                                            type="number"
                                            className="form-control"
                                            style={{ maxWidth: 120 }}
                                            min={1}
                                            max={1440}
                                            value={pingerSshIdleTimeoutMinutes}
                                            onChange={(e) => {
                                              const v = Number(e.target.value);
                                              if (Number.isFinite(v) && v >= 1) {
                                                setPingerSshIdleTimeoutMinutes(Math.min(Math.round(v), 1440));
                                              }
                                            }}
                                          />
                                          <button
                                            type="button"
                                            className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                            onClick={handleSavePingerSshIdle}
                                            disabled={pingerSshSaveBusy}
                                          >
                                            {pingerSshSaveBusy ? 'Saving…' : 'Save'}
                                          </button>
                                        </div>
                                      </div>
                                    </section>
                                    <section className="admin-settings-field-section">
                                      <div className="admin-pinger-cli-commands">
                                        <div className="admin-pinger-cli-head">
                                          <span className="admin-pinger-cli-head-icon" aria-hidden="true">
                                            &gt;_
                                          </span>
                                          <span>Common CLI commands</span>
                                        </div>
                                        <p className="admin-help-text small mb-2">
                                          Create a <strong>command group</strong> per Pinger host type. Commands appear beside the
                                          in-browser SSH session when the host&apos;s <strong>Type</strong> matches. Use{' '}
                                          <strong>All host types</strong> for snippets that apply everywhere.
                                        </p>
                                      {pingerDistinctTypes.length === 0 ? (
                                        <p className="admin-help-text small mb-2">
                                          No typed hosts yet — add hosts with a <strong>Type</strong> on the Pinger page to fill the
                                          dropdown, or create an &quot;All host types&quot; group below.
                                        </p>
                                      ) : null}
                                      <div className="admin-pinger-cli-toolbar">
                                        <label htmlFor="admin-pinger-new-cmd-group-type" className="mb-0 small">
                                          New group for type
                                        </label>
                                        <select
                                          id="admin-pinger-new-cmd-group-type"
                                          className="form-control form-control-sm"
                                          value={newPingerCmdGroupPick}
                                          onChange={(e) => setNewPingerCmdGroupPick(e.target.value)}
                                        >
                                          <option value="">All host types</option>
                                          {pingerDistinctTypes.map((t) => (
                                            <option key={t} value={t}>
                                              {t}
                                            </option>
                                          ))}
                                        </select>
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={() => {
                                            const pick = newPingerCmdGroupPick;
                                            setPingerSshCmdSections((prev) => {
                                              const next = prev.map((s) => ({
                                                ...s,
                                                commands: s.commands.map((c) => ({ ...c })),
                                              }));
                                              const lower = String(pick || '').trim().toLowerCase();
                                              const exist = next.findIndex(
                                                (s) =>
                                                  String(s.deviceType || '').trim().toLowerCase() === lower,
                                              );
                                              if (exist >= 0) {
                                                next[exist].commands.push({
                                                  _rowKey: pingerSshCmdRowKey(),
                                                  label: '',
                                                  command: '',
                                                });
                                                return next;
                                              }
                                              next.push({
                                                _sectionKey: pingerSshCmdRowKey(),
                                                deviceType: String(pick || '').trim(),
                                                commands: [
                                                  {
                                                    _rowKey: pingerSshCmdRowKey(),
                                                    label: '',
                                                    command: '',
                                                  },
                                                ],
                                              });
                                              return next;
                                            });
                                          }}
                                        >
                                          Add command group
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={handleExportPingerSshCommands}
                                        >
                                          Export JSON
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={handleOpenPingerSshCmdImport}
                                        >
                                          Import JSON
                                        </button>
                                      </div>
                                      {pingerSshCmdSections.length === 0 ? (
                                        <p className="admin-help-text small mb-3">No groups yet — add one above.</p>
                                      ) : null}
                                      <input
                                        ref={pingerSshCmdImportInputRef}
                                        type="file"
                                        accept="application/json,.json"
                                        style={{ display: 'none' }}
                                        onChange={handleImportPingerSshCommands}
                                      />
                                      {pingerSshCmdSections.map((sec, si) => {
                                        const dt = String(sec.deviceType || '').trim();
                                        const inDropdown =
                                          !dt ||
                                          pingerDistinctTypes.some(
                                            (t) => t.toLowerCase() === dt.toLowerCase(),
                                          );
                                        return (
                                          <div
                                            key={sec._sectionKey}
                                            className="admin-pinger-cli-group"
                                          >
                                            <div className="admin-pinger-cli-group__header">
                                              <div className="admin-pinger-cli-group__type">
                                                <label htmlFor={`pinger-cmd-sec-type-${sec._sectionKey}`}>
                                                  Host type
                                                </label>
                                                <select
                                                  id={`pinger-cmd-sec-type-${sec._sectionKey}`}
                                                  className="form-control form-control-sm"
                                                  value={dt}
                                                  onChange={(e) => {
                                                    const v = e.target.value;
                                                    setPingerSshCmdSections((prev) => {
                                                      const next = prev.map((s) => ({
                                                        ...s,
                                                        commands: s.commands.map((c) => ({ ...c })),
                                                      }));
                                                      const cur = next[si];
                                                      if (!cur) return prev;
                                                      const newTrim = String(v || '').trim();
                                                      const targetLower = newTrim.toLowerCase();
                                                      const otherIdx = next.findIndex(
                                                        (s, i) =>
                                                          i !== si &&
                                                          String(s.deviceType || '').trim().toLowerCase() ===
                                                            targetLower,
                                                      );
                                                      if (otherIdx >= 0) {
                                                        next[otherIdx].commands.push(...cur.commands);
                                                        next.splice(si, 1);
                                                        return next;
                                                      }
                                                      cur.deviceType = newTrim;
                                                      return next;
                                                    });
                                                  }}
                                                >
                                                  <option value="">All host types</option>
                                                  {pingerDistinctTypes.map((t) => (
                                                    <option key={t} value={t}>
                                                      {t}
                                                    </option>
                                                  ))}
                                                  {!inDropdown && dt ? (
                                                    <option value={dt}>
                                                      {dt} (not in Pinger list)
                                                    </option>
                                                  ) : null}
                                                </select>
                                              </div>
                                              <button
                                                type="button"
                                                className="btn btn-outline-danger btn-sm"
                                                onClick={() =>
                                                  setPingerSshCmdSections((prev) =>
                                                    prev.filter((_, i) => i !== si),
                                                  )
                                                }
                                              >
                                                Remove group
                                              </button>
                                            </div>
                                            <div className="table-responsive">
                                              <table className="admin-users-table admin-pinger-cli-table mb-2">
                                                <thead>
                                                  <tr>
                                                    <th scope="col" className="admin-pinger-cli-col-label">
                                                      Label
                                                    </th>
                                                    <th scope="col" className="admin-pinger-cli-col-cmd">
                                                      Command
                                                    </th>
                                                    <th scope="col" />
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {sec.commands.map((row, ci) => (
                                                    <tr key={row._rowKey}>
                                                      <td className="admin-pinger-cli-col-label">
                                                        <input
                                                          type="text"
                                                          className="form-control form-control-sm"
                                                          placeholder="Short title"
                                                          aria-label="Command label"
                                                          value={row.label}
                                                          onChange={(e) => {
                                                            const val = e.target.value;
                                                            setPingerSshCmdSections((prev) => {
                                                              const next = prev.map((s) => ({
                                                                ...s,
                                                                commands: s.commands.map((c) => ({ ...c })),
                                                              }));
                                                              if (!next[si]?.commands[ci]) return prev;
                                                              next[si].commands[ci] = {
                                                                ...next[si].commands[ci],
                                                                label: val,
                                                              };
                                                              return next;
                                                            });
                                                          }}
                                                        />
                                                      </td>
                                                      <td className="admin-pinger-cli-col-cmd">
                                                        <input
                                                          type="text"
                                                          className="form-control form-control-sm text-monospace admin-pinger-cli-input-cmd"
                                                          placeholder="show configuration | display set"
                                                          aria-label="CLI command"
                                                          value={row.command}
                                                          onChange={(e) => {
                                                            const val = e.target.value;
                                                            setPingerSshCmdSections((prev) => {
                                                              const next = prev.map((s) => ({
                                                                ...s,
                                                                commands: s.commands.map((c) => ({ ...c })),
                                                              }));
                                                              if (!next[si]?.commands[ci]) return prev;
                                                              next[si].commands[ci] = {
                                                                ...next[si].commands[ci],
                                                                command: val,
                                                              };
                                                              return next;
                                                            });
                                                          }}
                                                        />
                                                      </td>
                                                      <td>
                                                        <button
                                                          type="button"
                                                          className="btn btn-outline-secondary btn-sm me-1"
                                                          disabled={ci === 0}
                                                          onClick={() => movePingerSshCmdRow(si, ci, -1)}
                                                        >
                                                          ↑
                                                        </button>
                                                        <button
                                                          type="button"
                                                          className="btn btn-outline-secondary btn-sm me-1"
                                                          disabled={ci === sec.commands.length - 1}
                                                          onClick={() => movePingerSshCmdRow(si, ci, 1)}
                                                        >
                                                          ↓
                                                        </button>
                                                        <button
                                                          type="button"
                                                          className="btn btn-danger btn-sm"
                                                          onClick={() =>
                                                            setPingerSshCmdSections((prev) => {
                                                              const next = prev.map((s) => ({
                                                                ...s,
                                                                commands: s.commands.map((c) => ({ ...c })),
                                                              }));
                                                              if (!next[si]) return prev;
                                                              next[si].commands = next[si].commands.filter(
                                                                (_, i) => i !== ci,
                                                              );
                                                              if (next[si].commands.length === 0) {
                                                                next.splice(si, 1);
                                                              }
                                                              return next;
                                                            })
                                                          }
                                                        >
                                                          Remove
                                                        </button>
                                                      </td>
                                                    </tr>
                                                  ))}
                                                </tbody>
                                              </table>
                                            </div>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm admin-btn-ghost admin-pinger-cli-add-row"
                                              onClick={() =>
                                                setPingerSshCmdSections((prev) => {
                                                  const next = prev.map((s) => ({
                                                    ...s,
                                                    commands: s.commands.map((c) => ({ ...c })),
                                                  }));
                                                  if (!next[si]) return prev;
                                                  next[si].commands.push({
                                                    _rowKey: pingerSshCmdRowKey(),
                                                    label: '',
                                                    command: '',
                                                  });
                                                  return next;
                                                })
                                              }
                                            >
                                              Add command to this group
                                            </button>
                                          </div>
                                        );
                                      })}
                                      <div className="d-flex flex-wrap gap-2 align-items-center mt-2">
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                                          onClick={handleSavePingerSshCommands}
                                          disabled={pingerSshCmdSaveBusy}
                                        >
                                          {pingerSshCmdSaveBusy ? 'Saving…' : 'Save commands'}
                                        </button>
                                      </div>
                                      </div>
                                    </section>
                                  </>
                                ) : null}
                              </div>
                              <p className="admin-help-text small mb-2 mt-1">
                                <AdminRequiredStar /> Marks fields that must be filled for this integration when it is active.
                                Secrets: leave blank when saving to keep the value already stored.
                              </p>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm admin-btn-primary-soft mt-3"
                                disabled={deploymentSaveBusy === sectionId}
                                onClick={() => handleSaveDeploymentSection(sectionId)}
                              >
                                {deploymentSaveBusy === sectionId ? 'Saving…' : 'Save this subsection'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  : null}
              </>
            )}

            {currentTab === 'checkmk' && checkmkUiEnabled && (
              <div className="row mb-4">
                <div className="col-md-12">
                  <div className="card admin-surface">
                    <div className="card-header admin-card-header d-flex flex-wrap align-items-center justify-content-between">
                      <h3 className="title admin-card-title mb-0">Down / unreachable hosts</h3>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm admin-btn-ghost"
                        onClick={fetchCheckmkDownHosts}
                        disabled={checkmkLoading}
                      >
                        {checkmkLoading ? 'Loading…' : 'Refresh'}
                      </button>
                    </div>
                    <div className="card-body">
                      {!checkmkPayload && checkmkLoading ? (
                        <p className="admin-help-text mb-0">Loading…</p>
                      ) : null}
                      {checkmkPayload?.message ? (
                        <p className="admin-help-text">{checkmkPayload.message}</p>
                      ) : null}
                      {checkmkPayload?.error ? (
                        <p className="text-danger mb-3">{checkmkPayload.error}</p>
                      ) : null}
                      {checkmkPayload?.cached ? (
                        <p className="admin-help-text mb-2">Showing cached result (updates every ~30s on server).</p>
                      ) : null}
                      {checkmkPayload &&
                      checkmkPayload.configured &&
                      !checkmkPayload.error &&
                      Array.isArray(checkmkPayload.hosts) ? (
                        checkmkPayload.hosts.length === 0 ? (
                          <p className="admin-help-text mb-0">No hosts in DOWN or UNREACH.</p>
                        ) : (
                          <div className="table-body-srvers table-body">
                            <table className="admin-users-table">
                              <thead>
                                <tr>
                                  <th>Host</th>
                                  <th>Alias</th>
                                  <th>State</th>
                                  <th>Downtime</th>
                                </tr>
                              </thead>
                              <tbody>
                                {checkmkPayload.hosts.map((h) => (
                                  <tr key={h.hostName}>
                                    <td>{h.hostName}</td>
                                    <td>{h.alias || '—'}</td>
                                    <td>{h.stateLabel}</td>
                                    <td>{h.downtimeSummary || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {currentTab === 'dataBackup' && (
              <div className="row mb-4">
                <div className="col-md-12">
                  <div className="card admin-surface">
                    <div className="card-header admin-card-header">
                      <h3 className="title admin-card-title">Full data export</h3>
                    </div>
                    <div className="card-body admin-settings-body">
                      <p className="admin-help-text mb-3">
                        Full backup is a <strong>ZIP</strong> file: <code>collections.json</code> (all database tables) plus
                        the <code>uploads/</code> tree streamed in without a per-file size limit—suitable for very large
                        sites (multi-GB). Optional: download <strong>JSON only</strong> (metadata, no uploaded files) as
                        plain or gzipped text. “Legacy” exports embed uploads as Base64 in one JSON file (can use extreme
                        RAM on huge libraries—prefer ZIP).
                      </p>
                      <div className="admin-toolbar admin-toolbar--wrap mb-4">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm admin-btn-primary-soft"
                          onClick={() => handleFullDataExport('zip')}
                        >
                          Download full backup (.zip)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm admin-btn-ghost"
                          onClick={() => handleFullDataExport('json')}
                        >
                          JSON data only (.json)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm admin-btn-ghost"
                          onClick={() => handleFullDataExport('gzip')}
                        >
                          JSON data only (.json.gz)
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm admin-btn-ghost"
                          onClick={() => handleFullDataExport('legacy-gzip')}
                          title="Single gzipped JSON with Base64-encoded uploads — may use huge memory; use only for small sites"
                        >
                          Legacy full (.json.gz, embedded files)
                        </button>
                      </div>

                      <h4 className="mb-2" style={{ fontSize: '1rem', color: '#e2e8f0' }}>
                        Restore from backup
                      </h4>
                      <p className="admin-help-text mb-3">
                        Import reads a <strong>.zip</strong> full backup (recommended), or a legacy / data-only JSON file.
                        Collections replace current data (missing keys become empty arrays). Files under <code>uploads/</code>{' '}
                        from a ZIP are restored; existing names are overwritten. Max upload size for this endpoint is 64 GB
                        (uses a temp file on the server).
                      </p>
                      <label className="btn btn-secondary btn-sm admin-btn-ghost mb-0" style={{ cursor: 'pointer' }}>
                        Choose backup file…
                        <input
                          type="file"
                          accept=".zip,application/zip,.json,.json.gz,application/gzip,application/json"
                          hidden
                          onChange={handleFullDataImportFile}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {currentTab === 'userChats' && (
              <div className="row mb-4">
                <div className="col-md-12">
                  <div className="card admin-surface">
                    <div className="card-header admin-card-header">
                      <div>
                        <h3 className="title admin-card-title mb-1">User chats</h3>
                        <p className="admin-help-text mb-0 small">
                          Read-only audit: search users (same directory as Chat — app accounts and AD when configured),
                          select someone, then load their sidebar. Messages use admin impersonation; you cannot post from
                          here.
                        </p>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="form-group mb-2">
                        <label htmlFor="admin-chat-user-search">Search users</label>
                        <input
                          id="admin-chat-user-search"
                          className="form-control"
                          value={adminChatUserSearchQuery}
                          onChange={(e) => {
                            const v = e.target.value;
                            setAdminChatUserSearchQuery(v);
                            if (adminChatDirTimerRef.current) {
                              window.clearTimeout(adminChatDirTimerRef.current);
                            }
                            const t = v.trim();
                            if (t.length < 1) {
                              setAdminChatUserHits([]);
                              return;
                            }
                            adminChatDirTimerRef.current = window.setTimeout(() => {
                              fetchAdminChatDirectory(t);
                            }, 320);
                          }}
                          placeholder="Name or username (min. 1 character)"
                          autoComplete="off"
                        />
                        {adminChatUserSearchLoading ? (
                          <p className="admin-help-text small mb-0 mt-1">Searching…</p>
                        ) : null}
                        {adminChatUserHits.length > 0 ? (
                          <ul className="admin-user-chats-search-hits" role="listbox" aria-label="User search results">
                            {adminChatUserHits.map((hit) => (
                              <li key={`${hit.source || 'app'}-${hit.username}`} role="none">
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={false}
                                  className="admin-user-chats-search-hit"
                                  onMouseDown={(ev) => ev.preventDefault()}
                                  onClick={() => pickAdminChatUser(hit)}
                                >
                                  <span className="admin-user-chats-search-hit-name">
                                    {hit.displayName || hit.username}
                                  </span>
                                  <span className="admin-user-chats-search-hit-meta">
                                    <span className="admin-user-chats-search-hit-user">{hit.username}</span>
                                    <span
                                      className={`admin-user-chats-search-hit-src${
                                        hit.source === 'ad' ? ' admin-user-chats-search-hit-src--ad' : ''
                                      }`}
                                      title={hit.source === 'ad' ? 'Active Directory' : 'App user'}
                                    >
                                      {hit.source === 'ad' ? 'AD' : 'App'}
                                    </span>
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <div className="d-flex flex-wrap align-items-end gap-2 mb-3">
                        <div className="form-group mb-0" style={{ minWidth: 220, flex: '1 1 220px' }}>
                          <label htmlFor="admin-chat-username">Login name (for API)</label>
                          <input
                            id="admin-chat-username"
                            className="form-control"
                            value={adminChatUsername}
                            onChange={(e) => {
                              setAdminChatUsername(e.target.value);
                              setAdminChatPickLabel('');
                            }}
                            placeholder="Set automatically when you pick from search"
                            autoComplete="off"
                          />
                          {adminChatPickLabel ? (
                            <p className="admin-help-text small mb-0 mt-1">Selected: {adminChatPickLabel}</p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={adminChatConvLoading}
                          onClick={fetchAdminUserChatConversations}
                        >
                          {adminChatConvLoading ? 'Loading…' : 'Load conversations'}
                        </button>
                      </div>
                      <div className="admin-user-chats-layout">
                        <div className="admin-user-chats-col">
                          <p className="admin-help-text small mb-2">Conversations</p>
                          {adminChatConversations.length === 0 && !adminChatConvLoading ? (
                            <p className="admin-help-text mb-0">Enter a user and load to see their chat list.</p>
                          ) : null}
                          <div className="admin-user-chats-conv-list" role="list">
                            {adminChatConversations.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                role="listitem"
                                className={`admin-user-chats-conv-btn${
                                  adminChatSelectedId === c.id ? ' admin-user-chats-conv-btn--active' : ''
                                }`}
                                onClick={() => {
                                  setAdminChatSelectedId(c.id);
                                  fetchAdminUserChatMessages(c.id);
                                }}
                              >
                                <strong>{c.title || c.id}</strong>
                                <span className="d-block text-muted small">
                                  {c.type === 'dm' ? 'Direct' : c.type === 'group' ? 'Group' : 'Channel'}
                                  {typeof c.unread === 'number' && c.unread > 0
                                    ? ` · ${c.unread} unread`
                                    : ''}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="admin-user-chats-col">
                          <p className="admin-help-text small mb-2">Messages</p>
                          {!adminChatSelectedId ? (
                            <p className="admin-help-text mb-0">Select a conversation.</p>
                          ) : adminChatMsgLoading ? (
                            <p className="admin-help-text mb-0">Loading…</p>
                          ) : adminChatMessages.length === 0 ? (
                            <p className="admin-help-text mb-0">No messages in this thread.</p>
                          ) : (
                            <div className="admin-user-chats-msg-pane">
                              {adminChatMessages.map((m) => {
                                const dn = (m.fromDisplayName || '').trim();
                                const un = (m.fromUsername || '').trim();
                                const primary = dn || un || 'User';
                                const showLogin =
                                  dn && un && un.toLowerCase() !== dn.toLowerCase();
                                return (
                                  <div key={m._id} className="admin-user-chats-msg">
                                    <div className="admin-user-chats-msg-meta">
                                      <span className="admin-user-chats-msg-from">From</span> {primary}
                                      {showLogin ? <span className="text-muted"> ({un})</span> : null}
                                      {' · '}
                                      {m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}
                                    </div>
                                    {m.text ? (
                                      <p className="admin-user-chats-msg-body">{m.text}</p>
                                    ) : null}
                                    {Array.isArray(m.attachments) && m.attachments.length > 0 ? (
                                      <ul className="mb-0 ps-3">
                                        {m.attachments.map((a) => (
                                          <li key={a.url}>
                                            <a
                                              href={a.url}
                                              className="text-decoration-none"
                                              onClick={(e) => downloadAdminChatAttachment(e, a)}
                                            >
                                              {a.name || 'Attachment'}
                                            </a>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* View Modal */}
            {/* View Modal */}
            {isViewModalOpen && (
  <div className="modal-overlay">
      <div className="modal-content" ref={viewModalRef}>

      <h3 className="modal-title">View Request</h3>
      <form className="view-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-group">
          <label>Title: <strong>{title}</strong></label>
        </div>
        <div className="form-group">
          <label>Description:</label>
          <textarea
            rows="4"
            className="form-control"
            value={description} 
          disabled 
          />
                
                                
                            </div>
        <div className="form-group">
          <label>Status: <strong>{status}</strong></label>
        </div>
        <div className="form-group">
          <label>
            Opened at:{' '}
            <strong>{formatDateTime(selectedRequest?.createdAt) || '—'}</strong>
          </label>
        </div>
        {String(selectedRequest?.status || '').toLowerCase() === 'closed' && selectedRequest?.closedAt ? (
          <>
            <div className="form-group">
              <label>
                Closed by:{' '}
                <strong title={selectedRequest?.closedBy || ''}>
                  {selectedRequest?.closedByDisplayName || selectedRequest?.closedBy || 'Unknown'}
                </strong>
              </label>
            </div>
            <div className="form-group">
              <label>Closed at: <strong>{formatDateTime(selectedRequest.closedAt)}</strong></label>
            </div>
          </>
        ) : null}
        <div className="form-group">
          <label>Phone: <strong>{displayPhoneFromTicket(selectedRequest) || 'Not provided'}</strong></label>
        </div>
        <div className="form-group">
          <label>Department: <strong>{selectedRequest?.department || 'Not selected'}</strong></label>
        </div>
        <div className="form-group">
          <label>
            Requester:{' '}
            <strong title={formatCreatorTooltip(selectedRequest)}>
              {formatCreatorTableCell(selectedRequest)}
            </strong>
          </label>
          <div className="admin-ticket-row-meta admin-ticket-row-meta--muted">
            {formatCreatorPreviewLine(selectedRequest)}
          </div>
        </div>
        <div className="form-group">
          <label>
            Assigned to:{' '}
            <strong title={selectedRequest?.assignedTo || ''}>
              {selectedRequest?.assignedTo
                ? (selectedRequest?.assignedToDisplayName || selectedRequest?.assignedTo)
                : 'Unassigned'}
            </strong>
          </label>
        </div>
        <div className="form-group">
            <label>Comments:</label>                       
        </div>
        <div className="form-group">
        
        <ul className="comment-list">
  {(selectedRequest?.comments || []).length > 0 ? (
    selectedRequest.comments.map((comment, idx) => (
      <li className="comment-text comment-text--clean" key={`${comment.commentDate || ''}-${idx}`}>
        <div className="comment-meta-line">
          <strong>{comment.commentedByDisplayName || comment.commentedBy || 'User'}</strong>
          <span> · {formatDate(comment.commentDate)}</span>
        </div>
        <p className="comment-body-line">{String(comment.commentText || '').trim() || '—'}</p>
      </li>
    ))
  ) : (
    <li className="comment-text comment-text--empty">No comments yet.</li>
  )}
</ul>
        </div>
        <div className="button-container">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setIsViewModalOpen(false)}
          >
            Close
          </button>
        </div>
      </form>
    </div>
  </div>
)}
            {isModalOpen && (
  <div className="modal-overlay" onClick={() => closeNotificationModal()}>
    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
      <h3 className="modal-title">{editingNotificationId ? 'Edit notification' : 'Add notification'}</h3>
      <form className="view-form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-group">
          <label>Title:</label>
          <input
            type="text"
            className="form-control"
            value={notificationTitle}
            onChange={(e) => setNotificationTitle(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label>Description:</label>
          <textarea
            rows="4"
            className="form-control"
            value={notificationDescription}
            onChange={(e) => setNotificationDescription(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label>Icon (Unicode/Emoji):</label>
          <input
            type="text"
            className="form-control"
            value={notificationIcon}
            onChange={(e) => setNotificationIcon(e.target.value)}
            placeholder="e.g. 🌟 or U+1F31F"
          />
        </div>
        <div className="form-group">
          <label>Link (URL):</label>
          <input
            type="text"
            className="form-control"
            value={notificationLink}
            onChange={(e) => setNotificationLink(e.target.value)}
            placeholder="https://example.com"
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => closeNotificationModal()}
        >
          Close
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleSaveNotification}
          disabled={!notificationTitle || !notificationDescription}
        >
          {editingNotificationId ? 'Save changes' : 'Add notification'}
        </button>
      </form>
        
      </div>
    </div>
)}
            {/* Edit Modal */}
            {isEditModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content" ref={editModalRef}>
                        <h3 className="modal-title">{selectedRequest ? 'Edit Request' : 'New Request'}</h3>
                        <form onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title: </label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Description:</label>
                                <textarea
                                    rows="4"
                                    className="form-control"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Phone type</label>
                                <select
                                    className="form-control"
                                    value={phoneKind}
                                    onChange={(e) => {
                                      setPhoneKind(e.target.value);
                                      setPhoneNumber('');
                                    }}
                                >
                                    <option value={PHONE_KIND_MOBILE}>Mobile — 10 digits starting with 05</option>
                                    <option value={PHONE_KIND_INTERNAL}>Internal — 4 or 7 digits</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>
                                  {phoneKind === PHONE_KIND_MOBILE
                                    ? 'Mobile number'
                                    : 'Extension (4 or 7 digits)'}
                                </label>
                                {phoneKind === PHONE_KIND_INTERNAL ? (
                                  <input
                                    type="text"
                                    className="form-control"
                                    style={{ maxWidth: '200px' }}
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={7}
                                    value={phoneNumber}
                                    onChange={(e) =>
                                      setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 7))
                                    }
                                    placeholder="0000 or 0000000"
                                  />
                                ) : (
                                  <input
                                    type="text"
                                    className="form-control"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={10}
                                    placeholder="0501234567"
                                    value={phoneNumber}
                                    onChange={(e) =>
                                      setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))
                                    }
                                  />
                                )}
                                <small>
                                  {phoneKind === PHONE_KIND_MOBILE
                                    ? 'Exactly 10 digits, must start with 05.'
                                    : 'Exactly 4 or 7 digits (internal extension).'}
                                </small>
                            </div>
                            <div className="form-group">
                                <label>Department:</label>
                                <select
                                    className="form-control"
                                    value={department}
                                    onChange={(e) => setDepartment(e.target.value)}
                                >
                                    <option value="">Select department</option>
                                    {departments.map((item) => (
                                        <option key={item._id} value={item.name}>
                                            {item.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Status:</label>
                                <select
                                    className="form-control"
                                    value={status}
                                    onChange={(e) => setStatus(e.target.value)}
                                >
                                    <option value="pending">pending</option>
                                    <option value="in progress">In Progress</option>
                                    <option value="closed">Closed</option>
                                </select>
                            </div>
                            <div className="form-group">
    <label>Assign To</label>
    <select
        className="form-control"
        value={assignedTo || ''}
        onChange={(e) => setAssignedTo(e.target.value)}
    >
        <option value="Unassigned" onChange={(e) => setAssignedTo(e.target.value)}>No one</option>
        {adminUsers.map(username => (
            <option key={username} value={username}>
                {username}
            </option>
        ))}
    </select>
</div>
                            <div className="button-container">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setIsEditModalOpen(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={selectedRequest ? handleUpdateRequest : handleCreateNewRequest}
                                    disabled={!title || !description || !isPhoneFormValid(phoneKind, phoneNumber)}
                                >
                                    {selectedRequest ? 'Save Changes' : 'Create Request'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {/* Comment Modal */}
            {isCommentModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content" ref={commentModalRef}>
                        <h3 className="modal-title">Add Comment</h3>
                        <form onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title: <strong>{title}</strong></label>
                               
                            </div>
                            <div className="form-group">
          <label>Request summary:</label>
          <p className="admin-request-summary">
            {String(description || '').trim() || 'No description provided.'}
          </p>
                
                                
                            </div>
                            <div className="form-group">
                                <label>Comment:</label>
                                <textarea
                                    rows="4"
                                    className="form-control"
                                    value={commentText}
                                    onChange={(e) => setCommentText(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="button-container">
                            <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setIsCommentModalOpen(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleAddComment}
                                    disabled={!commentText}
                                >
                                    Add Comment
                                </button>
                                
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {shortcutModalOpen && (
                <div
                    className="modal-overlay"
                    onClick={() => {
                        setShortcutModalOpen(false);
                        resetShortcutForm();
                    }}
                >
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">{editingShortcutId ? 'Edit shortcut' : 'Add shortcut'}</h3>
                        {shortcutModalError ? (
                            <div className="admin-alert admin-alert--error mb-3" role="alert">
                                {shortcutModalError}
                            </div>
                        ) : null}
                        <form onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={scTitle}
                                    onChange={(e) => setScTitle(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>URL</label>
                                <input
                                    type="url"
                                    className="form-control"
                                    value={scUrl}
                                    onChange={(e) => {
                                        setScUrl(e.target.value);
                                        if (shortcutModalError) setShortcutModalError('');
                                    }}
                                    required
                                />
                                <AdminSettingsToggle
                                  className="mt-2"
                                  checked={scUseFaviconFromUrl}
                                  onChange={(v) => {
                                    setScUseFaviconFromUrl(v);
                                    if (shortcutModalError) setShortcutModalError('');
                                  }}
                                >
                                  <span>
                                    Use this shortcut’s URL to set the tile image from its site favicon when you
                                    save (overrides the image field below). Same LAN/private rules as the header
                                    logo: <code className="admin-inline-code">FAVICON_ALLOW_PRIVATE=true</code> if
                                    needed.
                                  </span>
                                </AdminSettingsToggle>
                            </div>
                            <div className="form-group">
                                <label>Description</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={scDesc}
                                    onChange={(e) => setScDesc(e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label>Category</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={scCategory}
                                    onChange={(e) => setScCategory(e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label>Image URL or path (optional)</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={scImg}
                                    onChange={(e) => setScImg(e.target.value)}
                                />
                                <input
                                    type="file"
                                    className="form-control mt-2"
                                    accept="image/jpeg,image/png,image/gif,image/webp"
                                    onChange={async (e) => {
                                        const file = e.target.files && e.target.files[0];
                                        e.target.value = '';
                                        if (!file) return;
                                        try {
                                            setError('');
                                            setShortcutModalError('');
                                            const url = await uploadAdminImage(file);
                                            setScImg(url);
                                        } catch (err) {
                                            const u = err.message || 'Upload failed';
                                            setShortcutModalError(u);
                                            setError(u);
                                        }
                                    }}
                                />
                            </div>
                            <div className="form-group">
                                <label>Sort order (optional)</label>
                                <input
                                    type="number"
                                    className="form-control"
                                    value={scSort}
                                    onChange={(e) => setScSort(e.target.value)}
                                />
                            </div>
                            <div className="form-group admin-checkbox-row">
                                <AdminSettingsToggle
                                    checked={scAdminOnly}
                                    onChange={setScAdminOnly}
                                >
                                    <span>Show this shortcut only to admins (hidden from other users on the home page)</span>
                                </AdminSettingsToggle>
                            </div>

                            <hr className="admin-form-separator" />
                            <p className="admin-help-text small mb-2">
                                Help library man-page: shown when a user opens this app from the Help library tab.
                                Leave blank to omit a section.
                            </p>

                            <div className="form-group">
                                <label>Summary (purpose of the app)</label>
                                <textarea
                                    className="form-control"
                                    rows={3}
                                    value={scSummary}
                                    onChange={(e) => setScSummary(e.target.value)}
                                    placeholder="One or two sentences describing what this app is for."
                                />
                            </div>

                            <div className="form-group">
                                <label>Use cases</label>
                                {scUseCases.length === 0 ? (
                                    <p className="text-muted small mb-2">No use cases yet.</p>
                                ) : (
                                    scUseCases.map((row, index) => (
                                        <div
                                            key={`uc-${index}`}
                                            className="admin-repeater-row"
                                        >
                                            <input
                                                type="text"
                                                className="form-control"
                                                value={row}
                                                onChange={(e) => {
                                                    const next = [...scUseCases];
                                                    next[index] = e.target.value;
                                                    setScUseCases(next);
                                                }}
                                                placeholder="e.g. Quickly check a host's status"
                                            />
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-outline-danger"
                                                onClick={() =>
                                                    setScUseCases(
                                                        scUseCases.filter((_, i) => i !== index),
                                                    )
                                                }
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    ))
                                )}
                                <button
                                    type="button"
                                    className="btn btn-sm admin-btn-ghost"
                                    onClick={() => setScUseCases([...scUseCases, ''])}
                                >
                                    + Add use case
                                </button>
                            </div>

                            <div className="form-group">
                                <label>Examples</label>
                                {scExamples.length === 0 ? (
                                    <p className="text-muted small mb-2">No examples yet.</p>
                                ) : (
                                    scExamples.map((ex, index) => (
                                        <div
                                            key={`ex-${index}`}
                                            className="admin-repeater-block"
                                        >
                                            <div className="admin-repeater-row">
                                                <input
                                                    type="text"
                                                    className="form-control"
                                                    value={ex.title}
                                                    onChange={(e) => {
                                                        const next = [...scExamples];
                                                        next[index] = { ...ex, title: e.target.value };
                                                        setScExamples(next);
                                                    }}
                                                    placeholder="Example title (optional)"
                                                />
                                                <button
                                                    type="button"
                                                    className="btn btn-sm btn-outline-danger"
                                                    onClick={() =>
                                                        setScExamples(
                                                            scExamples.filter((_, i) => i !== index),
                                                        )
                                                    }
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                            <textarea
                                                className="form-control"
                                                rows={3}
                                                value={ex.body}
                                                onChange={(e) => {
                                                    const next = [...scExamples];
                                                    next[index] = { ...ex, body: e.target.value };
                                                    setScExamples(next);
                                                }}
                                                placeholder="Command, snippet, or example walkthrough."
                                            />
                                        </div>
                                    ))
                                )}
                                <button
                                    type="button"
                                    className="btn btn-sm admin-btn-ghost"
                                    onClick={() =>
                                        setScExamples([...scExamples, { title: '', body: '' }])
                                    }
                                >
                                    + Add example
                                </button>
                            </div>
                            <div className="button-container">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => {
                                        setShortcutModalOpen(false);
                                        resetShortcutForm();
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleSaveShortcut}
                                    disabled={!scTitle.trim() || !scUrl.trim()}
                                >
                                    {editingShortcutId ? 'Save' : 'Add'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {manPageModalOpen && (
                <div
                    className="modal-overlay"
                    onClick={() => {
                        if (!mpBusy) closeManPageEditor();
                    }}
                >
                    <div
                        className="modal-content modal-content--help-form text-left"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="modal-title text-center mb-1">Edit man-page</h3>
                        <p className="admin-help-text small text-center mb-3">{mpAppTitle}</p>
                        {mpError ? (
                            <div className="admin-alert admin-alert--error mb-3" role="alert">
                                {mpError}
                            </div>
                        ) : null}
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                handleSaveManPage();
                            }}
                        >
                            <div className="form-group">
                                <label>Summary (purpose of the app)</label>
                                <textarea
                                    className="form-control"
                                    rows={3}
                                    value={mpSummary}
                                    onChange={(e) => setMpSummary(e.target.value)}
                                    placeholder="One or two sentences describing what this app is for."
                                />
                            </div>

                            <div className="form-group">
                                <label>Use cases</label>
                                {mpUseCases.length === 0 ? (
                                    <p className="text-muted small mb-2">No use cases yet.</p>
                                ) : (
                                    mpUseCases.map((row, index) => (
                                        <div key={`mp-uc-${index}`} className="admin-repeater-row">
                                            <input
                                                type="text"
                                                className="form-control"
                                                value={row}
                                                onChange={(e) => {
                                                    const next = [...mpUseCases];
                                                    next[index] = e.target.value;
                                                    setMpUseCases(next);
                                                }}
                                                placeholder="e.g. Quickly check a host's status"
                                            />
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-outline-danger"
                                                onClick={() =>
                                                    setMpUseCases(mpUseCases.filter((_, i) => i !== index))
                                                }
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    ))
                                )}
                                <button
                                    type="button"
                                    className="btn btn-sm admin-btn-ghost"
                                    onClick={() => setMpUseCases([...mpUseCases, ''])}
                                >
                                    + Add use case
                                </button>
                            </div>

                            <div className="form-group">
                                <label>Examples</label>
                                {mpExamples.length === 0 ? (
                                    <p className="text-muted small mb-2">No examples yet.</p>
                                ) : (
                                    mpExamples.map((ex, index) => (
                                        <div key={`mp-ex-${index}`} className="admin-repeater-block">
                                            <div className="admin-repeater-row">
                                                <input
                                                    type="text"
                                                    className="form-control"
                                                    value={ex.title}
                                                    onChange={(e) => {
                                                        const next = [...mpExamples];
                                                        next[index] = { ...ex, title: e.target.value };
                                                        setMpExamples(next);
                                                    }}
                                                    placeholder="Example title (optional)"
                                                />
                                                <button
                                                    type="button"
                                                    className="btn btn-sm btn-outline-danger"
                                                    onClick={() =>
                                                        setMpExamples(mpExamples.filter((_, i) => i !== index))
                                                    }
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                            <textarea
                                                className="form-control"
                                                rows={3}
                                                value={ex.body}
                                                onChange={(e) => {
                                                    const next = [...mpExamples];
                                                    next[index] = { ...ex, body: e.target.value };
                                                    setMpExamples(next);
                                                }}
                                                placeholder="Command, snippet, or example walkthrough."
                                            />
                                        </div>
                                    ))
                                )}
                                <button
                                    type="button"
                                    className="btn btn-sm admin-btn-ghost"
                                    onClick={() =>
                                        setMpExamples([...mpExamples, { title: '', body: '' }])
                                    }
                                >
                                    + Add example
                                </button>
                            </div>

                            <div className="button-container">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={closeManPageEditor}
                                    disabled={mpBusy}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="btn btn-secondary"
                                    disabled={mpBusy}
                                >
                                    {mpBusy ? 'Saving…' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            </div>
          </main>
        </div>
    );
};
export default AdminDashboard;