/**
 * True for links a browser would run or render as a page instead of opening.
 * Browsers ignore spaces and control characters in a scheme, so those are removed first.
 */
function isDangerousUrl(value) {
  // eslint-disable-next-line no-control-regex
  const s = String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (/^data:image\/(png|jpe?g|gif|webp);/.test(s)) return false;
  return /^(javascript|data|vbscript|file|blob):/.test(s);
}

/** A host name or IP address for ping and SSH. It must not start with "-", or it would be read as an option. */
function isValidHostAddress(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:%-]{0,253}$/.test(String(value ?? ''));
}

module.exports = { isDangerousUrl, isValidHostAddress };
