/**
 * Title-case each whitespace-separated word (e.g. "core ROUTER" -> "Core Router").
 */
function titleCaseType(s) {
  const trimmed = String(s || '').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Reuse an existing type string when it matches case-insensitively; otherwise title-case the input.
 * @param {string|undefined|null} raw
 * @param {Array<{ _id?: string, type?: string }>} allHosts
 * @param {string|undefined} [excludeHostId] - skip this host when scanning (for PUT)
 */
function resolvePingerType(raw, allHosts, excludeHostId) {
  const t = raw != null ? String(raw).trim() : '';
  if (!t) return '';
  const lower = t.toLowerCase();
  const ex = excludeHostId != null ? String(excludeHostId) : null;
  for (let i = 0; i < allHosts.length; i += 1) {
    const row = allHosts[i];
    if (ex != null && String(row._id) === ex) continue;
    const et = String(row.type || '').trim();
    if (et && et.toLowerCase() === lower) return et;
  }
  return titleCaseType(t);
}

module.exports = {
  titleCaseType,
  resolvePingerType,
};
