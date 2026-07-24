const express = require('express');
const router = express.Router();
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const {
  normalizePhoneFromClient,
  normalizePhoneFromImport,
  assertValidStoredPhone,
} = require('../utils/ticketPhone');
const { getUserEmailDomain, escapeRegex } = require('../utils/userEmailDomain');
const ldapSingleton = require('../services/ldapSingleton');
const { logFailure } = require('../utils/failureLog');
const { notifyTicketClosedByDm, notifyTicketAssignmentChanged } = require('../utils/chatTicketDm');
const Ticket = collections.tickets;

let ldapServiceForImport = null;
function getLdapForImport() {
  if (!process.env.LDAP_URL) return null;
  if (!ldapServiceForImport) {
    ldapServiceForImport = require('../services/ldapSingleton');
  }
  return ldapServiceForImport;
}

/** When DC is down, LDAP lookups can hang; pause display-name resolution for a while after a timeout. */
let ldapDisplayNamesPausedUntil = 0;

function isLdapDisplayLookupEnabled() {
  const v = (process.env.LDAP_DISPLAY_NAME_LOOKUP || 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

function ldapLookupTimeoutMs() {
  const n = Number(process.env.LDAP_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

function pauseLdapDisplayNames(seconds) {
  const s = Number(seconds);
  const sec = Number.isFinite(s) && s > 0 ? s : 120;
  ldapDisplayNamesPausedUntil = Date.now() + sec * 1000;
}

function isLdapDisplayNamesPaused() {
  return Date.now() < ldapDisplayNamesPausedUntil;
}

async function safeFindUserForDisplay(ldap, candidate) {
  if (!ldap || !isLdapDisplayLookupEnabled() || isLdapDisplayNamesPaused()) return null;
  const ms = ldapLookupTimeoutMs();
  let timeoutId;
  try {
    const u = await Promise.race([
      ldap.findUserByName(candidate),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(Object.assign(new Error('LDAP display-name lookup timed out'), { code: 'LDAP_TIMEOUT' })),
          ms,
        );
      }),
    ]);
    return u;
  } catch (e) {
    if (e && e.code === 'LDAP_TIMEOUT') {
      pauseLdapDisplayNames(Number(process.env.LDAP_DISPLAY_NAME_PAUSE_SEC) || 120);
    }
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const ALLOWED_STATUS = new Set(['pending', 'in progress', 'closed']);

function normLogin(u) {
  if (u == null) return '';
  const s = String(u).trim().toLowerCase();
  const at = s.indexOf('@');
  return at >= 0 ? s.slice(0, at) : s;
}

/** Local / sAM part for display (preserves case). */
function loginAccountName(stored) {
  if (stored == null || String(stored).trim() === '') return '';
  const s = String(stored).trim();
  const at = s.indexOf('@');
  return at >= 0 ? s.slice(0, at) : s;
}

function sameUser(a, b) {
  return normLogin(a) === normLogin(b);
}

function canAccessUserTickets(req, res, next) {
  const { username } = req.params;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (req.user.isAdmin || sameUser(req.user.username, username)) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

function normalizeImportAssigned(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (
    lower.includes('unassign')
    || lower === 'n/a'
    || lower === '-'
    || lower === 'none'
    || lower === 'null'
  ) {
    return null;
  }
  const dom = getUserEmailDomain();
  if (dom) {
    const m = s.match(new RegExp(`^([^@]+)@${escapeRegex(dom)}$`, 'i'));
    if (m) return m[1];
  }
  return s;
}

async function resolveAssigneeWithLdap(adService, normalizedAssignee) {
  if (!adService || !normalizedAssignee) return normalizedAssignee;
  const candidates = [];
  if (normalizedAssignee.includes('@')) {
    candidates.push(normalizedAssignee);
    const local = normalizedAssignee.split('@')[0];
    if (local) candidates.push(local);
  } else {
    candidates.push(normalizedAssignee);
    const dom = getUserEmailDomain();
    if (dom) {
      candidates.push(`${normalizedAssignee}@${dom}`);
    }
  }
  const seen = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      const u = await adService.findUserByName(c);
      if (u && u.sAMAccountName) {
        return String(u.sAMAccountName).trim();
      }
      if (u && u.userPrincipalName) {
        const upn = String(u.userPrincipalName);
        const m = upn.match(/^([^@]+)@/i);
        if (m) return m[1].trim();
      }
    } catch (_) {
      /* try next */
    }
  }
  return normalizedAssignee;
}

async function resolveDisplayName(ldap, raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const rawStr = String(raw).trim();
  if (!ldap || !isLdapDisplayLookupEnabled() || isLdapDisplayNamesPaused()) return rawStr;
  const candidates = [];
  if (rawStr.includes('@')) {
    candidates.push(rawStr);
    const local = rawStr.split('@')[0];
    if (local) candidates.push(local);
  } else {
    candidates.push(rawStr);
    const dom = getUserEmailDomain();
    if (dom) {
      candidates.push(`${rawStr}@${dom}`);
    }
  }
  const seen = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const u = await safeFindUserForDisplay(ldap, c);
    if (u && (u.displayName || u.cn)) {
      const d = String(u.displayName || u.cn).trim();
      if (d) return d;
    }
    if (isLdapDisplayNamesPaused()) break;
  }
  return rawStr;
}

async function enrichTicketWithAdNames(ticket) {
  if (!ticket) return ticket;
  const ldap = getLdapForImport();
  const cache = new Map();
  const dn = async (raw) => {
    if (raw == null || String(raw).trim() === '') return '';
    const key = String(raw).trim();
    if (cache.has(key)) return cache.get(key);
    const v = await resolveDisplayName(ldap, key);
    cache.set(key, v);
    return v;
  };

  const createdByDisplayName = await dn(ticket.createdBy);
  const assignedToDisplayName = ticket.assignedTo ? await dn(ticket.assignedTo) : '';
  const closedByDisplayName = ticket.closedBy ? await dn(ticket.closedBy) : '';

  let comments = ticket.comments;
  if (Array.isArray(comments) && comments.length > 0) {
    comments = await Promise.all(
      comments.map(async (c) => ({
        ...c,
        commentedByDisplayName: c.commentedBy ? await dn(c.commentedBy) : '',
      })),
    );
  }

  return {
    ...ticket,
    createdByDisplayName,
    createdByAccountName: loginAccountName(ticket.createdBy),
    assignedToDisplayName,
    closedByDisplayName,
    comments: comments || ticket.comments,
  };
}

async function enrichTicketsWithAdNames(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) return tickets;
  const ldap = getLdapForImport();
  const cache = new Map();
  const dn = async (raw) => {
    if (raw == null || String(raw).trim() === '') return '';
    const key = String(raw).trim();
    if (cache.has(key)) return cache.get(key);
    const v = await resolveDisplayName(ldap, key);
    cache.set(key, v);
    return v;
  };

  const keys = new Set();
  for (let i = 0; i < tickets.length; i += 1) {
    const t = tickets[i];
    if (t.createdBy) keys.add(String(t.createdBy).trim());
    if (t.assignedTo) keys.add(String(t.assignedTo).trim());
    const com = t.comments;
    if (Array.isArray(com)) {
      for (let j = 0; j < com.length; j += 1) {
        if (com[j].commentedBy) keys.add(String(com[j].commentedBy).trim());
      }
    }
  }
  await Promise.all([...keys].map((k) => dn(k)));

  return Promise.all(
    tickets.map(async (t) => {
      const createdByDisplayName = t.createdBy ? cache.get(String(t.createdBy).trim()) || t.createdBy : '';
      const assignedToDisplayName = t.assignedTo
        ? cache.get(String(t.assignedTo).trim()) || t.assignedTo
        : '';
      const closedByDisplayName = t.closedBy
        ? cache.get(String(t.closedBy).trim()) || t.closedBy
        : '';
      let comments = t.comments;
      if (Array.isArray(comments) && comments.length > 0) {
        comments = comments.map((c) => ({
          ...c,
          commentedByDisplayName: c.commentedBy
            ? cache.get(String(c.commentedBy).trim()) || c.commentedBy
            : '',
        }));
      }
      return {
        ...t,
        createdByDisplayName,
        createdByAccountName: loginAccountName(t.createdBy),
        assignedToDisplayName,
        closedByDisplayName,
        comments: comments || t.comments,
      };
    }),
  );
}

function parseImportCreatedAt(val) {
  if (val == null || val === '') return undefined;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    const p1 = +m[1];
    const p2 = +m[2];
    const y = +m[3];
    let month;
    let day;
    if (p1 > 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12) {
      month = p1;
      day = p2;
    } else {
      month = p1;
      day = p2;
    }
    const d = new Date(y, month - 1, day);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d2 = new Date(s);
  if (!Number.isNaN(d2.getTime())) return d2.toISOString();
  return undefined;
}

// Get all tickets for a specific user (own tickets or admin)
router.get('/tickets/requests/:username', jwtMiddleware, canAccessUserTickets, async (req, res) => {
  try {
    const { username } = req.params;
    const tickets = await Ticket.find((ticket) => sameUser(ticket.createdBy, username));
    const enriched = await enrichTicketsWithAdNames(tickets);
    res.json(enriched);
  } catch (err) {
    logFailure('ticket.list.user', err, { path: req.path, username: req.params.username });
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all tickets (admins only)
router.get('/tickets/requests', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const tickets = await Ticket.all();
    const enriched = await enrichTicketsWithAdNames(tickets);
    res.json(enriched);
  } catch (err) {
    logFailure('ticket.list.all', err, { path: req.path });
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a new ticket (signed-in user only; createdBy must match token)
router.post('/tickets/requests', jwtMiddleware, async (req, res) => {
  try {
    const { title, description, createdBy, phoneKind, phoneNumber, department } = req.body;
    if (!title || !description || !createdBy) {
      return res.status(400).send('Title, Description, and UserID are required');
    }
    if (!sameUser(createdBy, req.user.username)) {
      return res.status(403).json({ error: 'createdBy must match the signed-in user' });
    }
    let phoneFields;
    try {
      phoneFields = normalizePhoneFromClient(phoneKind, phoneNumber);
    } catch (e) {
      return res.status(400).send(e.message);
    }

    const newTicket = await Ticket.insert({
      title,
      description,
      createdBy,
      phoneNumber: phoneFields.phoneNumber,
      department,
      status: 'pending',
      comments: [],
    });
    const enriched = await enrichTicketWithAdNames(newTicket);
    res.status(201).json(enriched);
  } catch (err) {
    logFailure('ticket.create', err, { path: req.path });
    res.status(500).send('Server error');
  }
});

// Update an existing ticket — admins: full access; owners: edit own (cannot change assignee)
router.put('/tickets/requests/:id', jwtMiddleware, async (req, res) => {
  try {
    const existing = await Ticket.findById(req.params.id);
    if (!existing) return res.status(404).send('Ticket not found');
    if (!req.user.isAdmin && !sameUser(existing.createdBy, req.user.username)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let { title, description, status, assignedTo, phoneKind, phoneNumber, department } = req.body;
    const allowedStatuses = ['pending', 'in progress', 'closed'];
    if (status !== undefined && !allowedStatuses.includes(status)) {
      return res.status(400).send('Invalid ticket status');
    }

    if (!req.user.isAdmin) {
      assignedTo = existing.assignedTo;
    }

    let nextPhoneNumber = existing.phoneNumber;
    if (phoneKind !== undefined && phoneNumber !== undefined) {
      try {
        nextPhoneNumber = normalizePhoneFromClient(phoneKind, phoneNumber).phoneNumber;
      } catch (e) {
        return res.status(400).send(e.message);
      }
    } else {
      const legacy = String(existing.phoneNumber || '').trim();
      if (legacy) {
        try {
          nextPhoneNumber = normalizePhoneFromImport(legacy).phoneNumber;
        } catch (e) {
          return res.status(400).send(
            `${e.message}. Edit the ticket and choose mobile (05…) or internal (4 or 7 digits).`,
          );
        }
      }
    }
    try {
      assertValidStoredPhone(nextPhoneNumber);
    } catch (e) {
      return res.status(400).send(e.message);
    }

    const mergedStatus = status !== undefined ? status : existing.status;
    const wasClosed = String(existing.status || '').toLowerCase() === 'closed';
    const becomesClosed = String(mergedStatus || '').toLowerCase() === 'closed';

    const updatePatch = {
      title,
      description,
      status,
      assignedTo,
      phoneNumber: nextPhoneNumber,
      department,
    };
    if (!wasClosed && becomesClosed) {
      updatePatch.closedAt = new Date().toISOString();
      updatePatch.closedBy = req.user.username;
    } else if (wasClosed && !becomesClosed) {
      updatePatch.closedAt = null;
      updatePatch.closedBy = null;
    }

    const updatedTicket = await Ticket.updateById(req.params.id, updatePatch);
    if (!updatedTicket) return res.status(404).send('Ticket not found');

    const enriched = await enrichTicketWithAdNames(updatedTicket);

    if (!wasClosed && becomesClosed) {
      const closer = normLogin(req.user.username);
      const owner = normLogin(existing.createdBy);
      if (closer !== owner) {
        notifyTicketClosedByDm({
          closerUsername: req.user.username,
          closerDisplayName: req.user.displayName,
          requesterUsername: existing.createdBy,
          ticketId: updatedTicket._id,
          ticketTitle: updatedTicket.title || existing.title,
        });
      }
    }

    const prevAssignee = existing.assignedTo != null ? String(existing.assignedTo).trim() : '';
    const nextAssignee = updatedTicket.assignedTo != null ? String(updatedTicket.assignedTo).trim() : '';
    if (req.user.isAdmin && normLogin(prevAssignee) !== normLogin(nextAssignee)) {
      notifyTicketAssignmentChanged({
        actorUsername: req.user.username,
        actorDisplayName: req.user.displayName,
        requesterUsername: existing.createdBy,
        previousAssigneeUsername: prevAssignee,
        newAssigneeUsername: nextAssignee,
        newAssigneeDisplayName: enriched.assignedToDisplayName,
        ticketId: updatedTicket._id,
        ticketTitle: updatedTicket.title || existing.title,
      });
    }

    res.json(enriched);
  } catch (err) {
    logFailure('ticket.update', err, { path: req.path, id: req.params.id });
    res.status(500).send('Server error');
  }
});

// Add a comment — admin any ticket; owner own ticket only
router.post('/tickets/requests/:id/comments', jwtMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Ticket.findById(id);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    if (!req.user.isAdmin && !sameUser(existing.createdBy, req.user.username)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { commentText } = req.body;
    if (!commentText) {
      return res.status(400).send('Comment text is required');
    }
    const commentedBy = req.user.username;

    const ticket = await Ticket.updateById(id, (ticketRow) => ({
      comments: [
        ...(ticketRow.comments || []),
        {
          commentedBy,
          commentText,
          commentDate: new Date().toISOString(),
        },
      ],
    }));
    if (!ticket) return res.status(404).send('Ticket not found');
    const enriched = await enrichTicketWithAdNames(ticket);
    res.json(enriched);
  } catch (error) {
    logFailure('ticket.comment', error, { path: req.path, id: req.params.id });
    res.status(500).json({ error: error.message });
  }
});

// Delete a ticket — admin any; owner own
router.delete('/tickets/requests/:id', jwtMiddleware, async (req, res) => {
  try {
    const existing = await Ticket.findById(req.params.id);
    if (!existing) return res.status(404).send('Ticket not found');
    if (!req.user.isAdmin && !sameUser(existing.createdBy, req.user.username)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const deletedTicket = await Ticket.deleteById(req.params.id);
    if (!deletedTicket) return res.status(404).send('Ticket not found');
    res.json(deletedTicket);
  } catch (err) {
    logFailure('ticket.delete', err, { path: req.path, id: req.params.id });
    res.status(500).send('Server error');
  }
});

router.post('/tickets/import', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { tickets, resolveAssignees = true } = req.body;
    if (!Array.isArray(tickets)) {
      return res.status(400).json({ message: 'Body must include a tickets array' });
    }
    const ldap = resolveAssignees !== false ? getLdapForImport() : null;
    const created = [];
    const skipped = [];
    for (const row of tickets) {
      if (!row || typeof row !== 'object') {
        skipped.push({ reason: 'invalid row' });
        continue;
      }
      const title = row.title != null ? String(row.title).trim() : '';
      const createdBy = row.createdBy != null ? String(row.createdBy).trim() : '';
      if (!title || !createdBy) {
        skipped.push({ title: title || '(empty)', reason: 'missing title or createdBy' });
        continue;
      }
      const description = row.description != null ? String(row.description).trim() : '';
      const phoneRaw = row.phoneNumber != null ? String(row.phoneNumber).trim() : '';
      let phoneFields;
      try {
        phoneFields = normalizePhoneFromImport(phoneRaw);
      } catch {
        /* Missing column / blank is already ''; unparseable values → store no phone instead of skipping */
        phoneFields = { phoneNumber: '' };
      }
      let status = row.status != null ? String(row.status).trim().toLowerCase() : 'pending';
      if (!ALLOWED_STATUS.has(status)) status = 'pending';
      const department = row.department != null ? String(row.department).trim() : '';
      let assignedTo = normalizeImportAssigned(row.assignedTo);
      if (assignedTo && ldap) {
        try {
          assignedTo = await resolveAssigneeWithLdap(ldap, assignedTo);
        } catch (err) {
          logFailure('ticket.import.assignee_ldap', err, {
            assignedTo: row.assignedTo != null ? String(row.assignedTo) : '',
          });
        }
      }
      const record = {
        title,
        description,
        createdBy,
        phoneNumber: phoneFields.phoneNumber,
        department,
        status,
        assignedTo,
        comments: Array.isArray(row.comments) ? row.comments : [],
      };
      const createdIso = parseImportCreatedAt(row.createdAt);
      if (createdIso) {
        record.createdAt = createdIso;
      }
      const t = await Ticket.insert(record);
      created.push(t);
    }
    const enrichedCreated = await enrichTicketsWithAdNames(created);
    res.status(201).json({
      imported: created.length,
      skipped: skipped.length,
      tickets: enrichedCreated,
      skipDetails: skipped,
    });
  } catch (err) {
    logFailure('ticket.import', err, { path: req.path, ticketCount: Array.isArray(req.body?.tickets) ? req.body.tickets.length : 0 });
    res.status(500).json({ message: err.message || 'Import failed' });
  }
});

module.exports = router;
