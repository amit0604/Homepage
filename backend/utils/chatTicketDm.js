const { collections } = require('../repositories/jsonStore');
const {
  ensureChatSchema,
  normUser,
  dmConvId,
  unhideConversationForUser,
  setLastRead,
} = require('./chatCore');
const { stripConfiguredEmailSuffix } = require('./userEmailDomain');
const { isLobbyChatUiEnabledByDeploy } = require('./lobbyChatUi');
const { logFailure } = require('./failureLog');

const Conv = collections.chatConversations;
const Msg = collections.chatMessages;
const Settings = collections.settings;

async function lobbyChatOperational() {
  if (!isLobbyChatUiEnabledByDeploy()) return false;
  try {
    const row = await Settings.findOne((record) => record.key === 'app');
    if (row) return row.lobbyChatEnabled !== false;
    return true;
  } catch {
    return false;
  }
}

async function postTicketDm({ fromUsername, fromDisplayName, toUsername, text, logTag, logMeta }) {
  try {
    if (!(await lobbyChatOperational())) return { ok: false, reason: 'chat_off' };
    await ensureChatSchema();
    const from = stripConfiguredEmailSuffix(String(fromUsername || '').trim());
    const to = stripConfiguredEmailSuffix(String(toUsername || '').trim());
    if (!from || !to || normUser(from) === normUser(to)) {
      return { ok: false, reason: 'skip_same_user' };
    }
    const id = dmConvId(from, to);
    if (!id) return { ok: false, reason: 'bad_dm' };
    let conv = await Conv.findById(id);
    if (!conv) {
      conv = await Conv.insert({
        _id: id,
        type: 'dm',
        memberUsernames: [normUser(from), normUser(to)],
        title: null,
      });
    }
    await Msg.insert({
      conversationId: id,
      text,
      fromUsername: from,
      fromDisplayName:
        fromDisplayName && String(fromDisplayName).trim() ? String(fromDisplayName).trim() : from,
      attachments: [],
      reactions: {},
    });
    await setLastRead(from, id, new Date().toISOString());
    await unhideConversationForUser(to, id);
    return { ok: true, conversationId: id };
  } catch (e) {
    logFailure(logTag, e, logMeta || {});
    return { ok: false, reason: 'error' };
  }
}

/**
 * Sends a DM from staff to the ticket requester when a ticket is closed (best-effort).
 */
async function notifyTicketClosedByDm({
  closerUsername,
  closerDisplayName,
  requesterUsername,
  ticketId,
  ticketTitle,
}) {
  const title = String(ticketTitle || 'Ticket').replace(/\r|\n/g, ' ').trim().slice(0, 160);
  const tid = String(ticketId || '').slice(0, 12);
  const text = `Your support ticket "${title || 'Ticket'}" (${tid}) has been closed. If you need anything else, reply here or open a new ticket.`;
  return postTicketDm({
    fromUsername: closerUsername,
    fromDisplayName: closerDisplayName,
    toUsername: requesterUsername,
    text,
    logTag: 'chat.ticket_closed_dm',
    logMeta: { requester: requesterUsername, ticketId },
  });
}

/**
 * When an admin sets or changes assignedTo: DM new assignee, previous assignee (if any), and requester.
 */
async function notifyTicketAssignmentChanged({
  actorUsername,
  actorDisplayName,
  requesterUsername,
  previousAssigneeUsername,
  newAssigneeUsername,
  newAssigneeDisplayName,
  ticketId,
  ticketTitle,
}) {
  const title = String(ticketTitle || 'Ticket').replace(/\r|\n/g, ' ').trim().slice(0, 160);
  const tid = String(ticketId || '').slice(0, 12);
  const ticketLine = `"${title || 'Ticket'}" (${tid})`;

  const prev = stripConfiguredEmailSuffix(String(previousAssigneeUsername || '').trim());
  const next = stripConfiguredEmailSuffix(String(newAssigneeUsername || '').trim());
  const requester = stripConfiguredEmailSuffix(String(requesterUsername || '').trim());
  const actor = stripConfiguredEmailSuffix(String(actorUsername || '').trim());

  const assigneeLabel =
    newAssigneeDisplayName && String(newAssigneeDisplayName).trim()
      ? String(newAssigneeDisplayName).trim()
      : next || 'a team member';

  if (next && normUser(next) !== normUser(actor)) {
    await postTicketDm({
      fromUsername: actorUsername,
      fromDisplayName: actorDisplayName,
      toUsername: next,
      text: `You have been assigned support ticket ${ticketLine}.`,
      logTag: 'chat.ticket_assign_assignee',
      logMeta: { ticketId, to: next },
    });
  }

  if (prev && normUser(prev) !== normUser(next) && normUser(prev) !== normUser(actor)) {
    await postTicketDm({
      fromUsername: actorUsername,
      fromDisplayName: actorDisplayName,
      toUsername: prev,
      text: `You are no longer assigned to support ticket ${ticketLine}.`,
      logTag: 'chat.ticket_assign_prev',
      logMeta: { ticketId, to: prev },
    });
  }

  if (requester && normUser(requester) !== normUser(actor)) {
    if (next) {
      await postTicketDm({
        fromUsername: actorUsername,
        fromDisplayName: actorDisplayName,
        toUsername: requester,
        text: `Your support ticket ${ticketLine} has been assigned to ${assigneeLabel}.`,
        logTag: 'chat.ticket_assign_requester',
        logMeta: { ticketId, to: requester },
      });
    } else if (prev) {
      await postTicketDm({
        fromUsername: actorUsername,
        fromDisplayName: actorDisplayName,
        toUsername: requester,
        text: `Your support ticket ${ticketLine} is no longer assigned to a specific person.`,
        logTag: 'chat.ticket_assign_requester',
        logMeta: { ticketId, to: requester },
      });
    }
  }
}

module.exports = {
  notifyTicketClosedByDm,
  notifyTicketAssignmentChanged,
  lobbyChatOperational,
};
