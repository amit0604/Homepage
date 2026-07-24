/**
 * sAM / local part of stored createdBy (UPN or plain login id).
 * Prefer API field createdByAccountName when present.
 */
export function getCreatorAccountName(ticket) {
  if (!ticket) return '';
  if (ticket.createdByAccountName != null && String(ticket.createdByAccountName).trim()) {
    return String(ticket.createdByAccountName).trim();
  }
  const c = ticket.createdBy;
  if (c == null || String(c).trim() === '') return '';
  const s = String(c).trim();
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

/** Primary line for UIs that should show a friendly name first (e.g. My requests). */
export function getCreatorDisplayName(ticket) {
  if (!ticket) return '—';
  const d = (ticket.createdByDisplayName || '').trim();
  if (d) return d;
  const acc = getCreatorAccountName(ticket);
  return acc || '—';
}

/** One line: "Display name (sAMAccountName)" */
export function formatCreatorLabel(ticket) {
  if (!ticket) return '—';
  const acc = getCreatorAccountName(ticket);
  const disp = (ticket.createdByDisplayName || '').trim();
  if (disp && acc && disp.toLowerCase() !== acc.toLowerCase()) {
    return `${disp} (${acc})`;
  }
  return disp || acc || '—';
}

/** Table "Created by" cell: show display name only (no sAM in the cell). */
export function formatCreatorTableCell(ticket) {
  if (!ticket) return '—';
  const disp = (ticket.createdByDisplayName || '').trim();
  return disp || '—';
}

/** Sub-line under ticket title: sAM and display together. */
export function formatCreatorPreviewLine(ticket) {
  if (!ticket) return '—';
  const acc = getCreatorAccountName(ticket);
  const disp = (ticket.createdByDisplayName || '').trim();
  if (acc && disp) return `${acc} · ${disp}`;
  return disp || acc || '—';
}

/** Tooltip / aria description with both identifiers. */
export function formatCreatorTooltip(ticket) {
  if (!ticket) return '';
  const acc = getCreatorAccountName(ticket);
  const disp = (ticket.createdByDisplayName || '').trim();
  const parts = [];
  if (acc) parts.push(`sAMAccountName: ${acc}`);
  if (disp) parts.push(`Display name: ${disp}`);
  return parts.join('\n');
}
