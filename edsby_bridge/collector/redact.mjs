/**
 * What the collector keeps out of a capture. Pure, so it can be tested
 * without a browser: this is the part where a mistake would send a password
 * somewhere.
 */

/** Paths never recorded, whatever they return. */
export const SKIP_PATH = /(log[io]n|logon|logout|sign[-_]?in|auth|oauth|saml|sso|password|credential|token|session|captcha)/i;
/** Query parameters and JSON keys whose values are replaced. */
export const SECRET_NAME = /^(password|passwd|pwd|pw|token|access_?token|refresh_?token|id_?token|ticket|session|session_?id|sid|secret|api_?key|key|auth|authorization|cookie|csrf|xsrf|nonce|sig|signature|code|state|otp|mfa)$/i;

export function cleanUrl(raw) {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_NAME.test(name)) url.searchParams.set(name, 'REDACTED');
  }
  return url.pathname + url.search;
}

export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_NAME.test(k) ? 'REDACTED' : redactValue(v);
    return out;
  }
  return value;
}

/** A body with its secrets removed. Unparseable bodies are scrubbed by pattern. */
export function redactBody(text) {
  try {
    return JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    return text.replace(
      /("(?:password|passwd|pwd|token|access_?token|refresh_?token|ticket|session(?:_?id)?|sid|secret|api_?key|cookie|csrf|xsrf|nonce|otp)"\s*:\s*)"[^"]*"/gi,
      '$1"REDACTED"'
    );
  }
}

export function looksLikeJson(contentType, text) {
  if (/json/i.test(contentType)) return true;
  const start = text.trimStart()[0];
  return start === '{' || start === '[';
}


const SIGN_IN_PAGE = /(log[io]n|sign[-_]?in|sso|saml|oauth|accounts\.google\.com|login\.microsoftonline\.com)/i;

export function isSignedInUrl(raw, host) {
  try {
    const url = new URL(raw);
    if (url.hostname !== host) return false;
    return !SIGN_IN_PAGE.test(url.pathname + url.search);
  } catch {
    return false;
  }
}
