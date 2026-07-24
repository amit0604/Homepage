const MOBILE_RE = /^05\d{8}$/;
/** Internal extension stored as digits only (4 or 7). */
const INTERNAL_EXT_RE = /^(?:\d{4}|\d{7})$/;

/**
 * @param {'mobile'|'internal'} phoneKind
 * @param {string} phoneNumber — mobile: 10 digits starting with 05; internal: 4 or 7 digits (stored without prefix)
 * @returns {{ phoneNumber: string }}
 */
function normalizePhoneFromClient(phoneKind, phoneNumber) {
  const kind = String(phoneKind || '').toLowerCase().trim();
  if (kind !== 'mobile' && kind !== 'internal') {
    throw new Error('phoneKind must be mobile or internal');
  }
  if (kind === 'mobile') {
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    if (!MOBILE_RE.test(digits)) {
      throw new Error('Mobile number must be 10 digits starting with 05');
    }
    return { phoneNumber: digits };
  }
  const ext = String(phoneNumber || '').replace(/\D/g, '');
  if (!INTERNAL_EXT_RE.test(ext)) {
    throw new Error('Internal extension must be exactly 4 or 7 digits');
  }
  return { phoneNumber: ext };
}

/**
 * Import: mobile 05…10 digits or bare 4/7 internal (digits only after stripping spaces).
 */
function normalizePhoneFromImport(raw) {
  const s = String(raw || '').trim();
  if (!s) return { phoneNumber: '' };
  const digits = s.replace(/\D/g, '');
  if (MOBILE_RE.test(digits)) return { phoneNumber: digits };
  if (/[-\s]/.test(s)) {
    throw new Error(
      'Phone must be 10 digits starting with 05, or internal 4 or 7 digits only (no hyphens or spaces for internal)',
    );
  }
  if (INTERNAL_EXT_RE.test(digits)) return { phoneNumber: digits };
  throw new Error('Phone must be 10 digits starting with 05, or internal 4 or 7 digits');
}

function assertValidStoredPhone(value) {
  const v = String(value || '').trim();
  if (!v) throw new Error('Phone number is required');
  if (MOBILE_RE.test(v)) return;
  if (INTERNAL_EXT_RE.test(v)) return;
  throw new Error('Stored phone must be mobile (05 + 8 digits) or internal (4 or 7 digits)');
}

module.exports = {
  normalizePhoneFromClient,
  normalizePhoneFromImport,
  assertValidStoredPhone,
  MOBILE_RE,
};
