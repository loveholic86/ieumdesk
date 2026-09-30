/** A reset token is only sent to an administrator after password reauthentication. */
export const passwordResetTtlMs = 30 * 60_000;
// A fragment keeps the credential out of HTTP requests, access logs and Referer headers.
export const passwordResetPath = (token: string) => `/#reset-password=${token}`;
