function normTypeKey(s) {
  return String(s || '').trim().toLowerCase();
}

/** Snippets with empty device type apply to all; otherwise match host type case-insensitively. */
export function sshCommonCommandsForHost(host, list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const ht = normTypeKey(host?.type);
  return list.filter((c) => {
    const dt = normTypeKey(c.deviceType);
    if (!dt) return true;
    if (!ht) return false;
    return dt === ht;
  });
}
