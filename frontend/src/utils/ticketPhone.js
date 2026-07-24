export const PHONE_KIND_MOBILE = 'mobile';
export const PHONE_KIND_INTERNAL = 'internal';

const INTERNAL_EXT_RE = /^(?:\d{4}|\d{7})$/;

/** Display line for view modals (single phone field). */
export function displayPhoneFromTicket(ticket) {
  if (!ticket) return '';
  return String(ticket.phoneNumber || '').trim();
}

export function formStateFromTicket(ticket) {
  const combined = String(ticket?.phoneNumber || '').trim();
  const d = combined.replace(/\D/g, '');
  if (d.length === 10 && /^05\d{8}$/.test(d)) {
    return {
      phoneKind: PHONE_KIND_MOBILE,
      phoneNumber: d,
    };
  }
  if (INTERNAL_EXT_RE.test(d) && (d.length === 4 || d.length === 7)) {
    return {
      phoneKind: PHONE_KIND_INTERNAL,
      phoneNumber: d,
    };
  }
  return {
    phoneKind: PHONE_KIND_MOBILE,
    phoneNumber: d.slice(0, 10),
  };
}

export function isPhoneFormValid(phoneKind, phoneNumber) {
  if (phoneKind === PHONE_KIND_MOBILE) {
    return /^05\d{8}$/.test(String(phoneNumber || '').replace(/\D/g, ''));
  }
  return INTERNAL_EXT_RE.test(String(phoneNumber || '').replace(/\D/g, ''));
}

export function buildPhoneApiBody(phoneKind, phoneNumber) {
  if (phoneKind === PHONE_KIND_MOBILE) {
    return {
      phoneKind: PHONE_KIND_MOBILE,
      phoneNumber: String(phoneNumber || '').replace(/\D/g, ''),
    };
  }
  const ext = String(phoneNumber || '').replace(/\D/g, '').slice(0, 7);
  return {
    phoneKind: PHONE_KIND_INTERNAL,
    phoneNumber: ext,
  };
}
