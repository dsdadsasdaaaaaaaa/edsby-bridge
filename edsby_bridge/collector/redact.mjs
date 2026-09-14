/**
 * What the collector keeps out of a capture. Pure, so it can be tested
 * without a browser: this is the part where a mistake would send a password
 * somewhere.
 */

/** Paths never recorded, whatever they return. */
export const SKIP_PATH = /(log[io]n|logon|logout|sign[-_]?in|auth|oauth|saml|sso|password|credential|token|session|captcha)/i;
/** Query parameters and JSON keys whose values are replaced. */
// Edsby's own sign-in challenge travels as _formkey, sauthdata, cauthdata and
// crypttype. It is not a password, but it is authentication material, so it
// is treated like one.
export const SECRET_NAME = /^(password|passwd|pwd|pw|token|access_?token|refresh_?token|id_?token|ticket|session|session_?id|sid|secret|api_?key|key|auth|authorization|cookie|csrf|xsrf|nonce|sig|signature|code|state|otp|mfa|_?formkey|[sc]?authdata|crypttype|extendedpasswords)$/i;

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


const SIGN_IN_PAGE = /(log[io]n|sign[-_]?in|sso|saml|oauth)/i;

/**
 * Is the browser past the sign-in screen?
 *
 * Judged from what the page IS, not only its address: Edsby shows its login
 * at /p/BasePublic/ — no "login" in the path — so an address check alone
 * reported a browser that had never signed in as signed in. A visible
 * password field, the "Edsby: Login" title, the public shell, or being on
 * Google's or Microsoft's sign-in pages all mean not yet.
 */
export function isSignedInState({ url, title = '', hasPasswordField = false }, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== host) return false;
  if (hasPasswordField) return false;
  if (/\blog\s?in\b|sign\s?in/i.test(title)) return false;
  if (/\/p\/BasePublic\b/i.test(parsed.pathname)) return false;
  if (SIGN_IN_PAGE.test(parsed.pathname + parsed.search)) return false;
  return true;
}

/**
 * The browser identity Edsby is shown.
 *
 * Edsby answers the testing build of Chromium with "Unsupported Browser"
 * instead of its login page. The same engine, introduced as the ordinary
 * desktop Chrome of the same version, gets the real site. Built from the
 * bundled version so it never drifts out of step with the engine underneath.
 */
export function desktopUserAgent(browserVersion) {
  const major = String(browserVersion || '').split('.')[0] || '140';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
