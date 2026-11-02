// The secrets the core and the method components hand out (STUDY-201 §1.3): random tokens, base64url, and the
// SHA-256 they are stored and looked up by, so the token itself is never stored. In a mutation, `crypto` draws from
// its seeded stream.

/** The lowercase hex SHA-256 of `value`'s UTF-8 bytes. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** `bytes` in base64url, without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes in base64url (43 characters): a refresh token, a ticket, a challenge. */
export function generateRandomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
