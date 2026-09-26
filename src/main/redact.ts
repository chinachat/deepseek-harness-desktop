/**
 * Credential redaction for everything this process writes down or shows.
 *
 * dsh mints a fresh session token on every launch and announces the UI as
 * `http://127.0.0.1:<port>/?token=<secret>`. That URL is a handle on a live
 * agent — the token exchanges for the signed session cookie, and the agent can
 * execute shell commands — so it must never reach the log file, the log window,
 * the tray, or a screenshot of either.
 *
 * Two complementary helpers live here: {@link redactSecrets} scrubs free-form
 * text that may contain a URL (dsh's own stdout, error strings), and
 * {@link publicUrl} drops the query entirely where the URL is known to carry
 * the token, so nothing depends on the parameter list below staying current.
 */

/**
 * A credential-carrying parameter and its value, anywhere in a line.
 *
 * Covers both URL query strings (`?token=…`, `&api_key=…`) and the
 * semicolon-separated form a `Cookie`/`Authorization`-style header would use,
 * because either can end up in a log line. The value ends at whitespace or at a
 * character that normally terminates a token in prose, so surrounding
 * punctuation (a wrapping `)`, a trailing `,`, the next `;`) survives
 * untouched. Real dsh tokens are base64url (`A-Za-z0-9-_`), so none of those
 * terminators can appear inside one.
 */
const SECRET_QUERY = /([?&;]\s*(?:token|access_token|auth|api[_-]?key|key|secret|password|passwd)=)[^&\s"'#),;]+/gi;

/** Replace every credential-looking query value in `text` with `***`. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_QUERY, "$1***");
}

/**
 * A URL that is safe to log or to show in the UI: scheme, host, port and path
 * only, with the query and fragment dropped.
 *
 * Falls back to {@link redactSecrets} when the input is not parseable as a URL,
 * so a malformed announce line still cannot smuggle a token into the log.
 */
export function publicUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return redactSecrets(url);
  }
}
