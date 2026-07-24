/** True only when JWT has numeric exp and clock has passed it. Tokens without exp never expire locally. */
export function isJwtExpired(decoded) {
  if (!decoded || typeof decoded !== 'object') return false;
  const exp = decoded.exp;
  if (exp == null || typeof exp !== 'number') return false;
  return Math.floor(Date.now() / 1000) >= exp;
}
