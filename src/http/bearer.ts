import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time bearer token comparison for the deployed HTTP routes.
 *
 * Shared by every route so no endpoint invents its own check. Returns false when
 * no token is configured: an unset secret must LOCK the endpoint, never open it.
 */
export function isAuthorized(
  headerValue: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected.length === 0) return false;

  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (header === undefined) return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so length is checked first. The
  // length of a token is not a useful secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * True when the presented header matches ANY configured token.
 *
 * Every candidate is compared even after a match, so the time taken does not
 * reveal which secret was the one that matched.
 */
export function isAuthorizedByAny(
  headerValue: string | string[] | undefined,
  expected: ReadonlyArray<string | undefined>,
): boolean {
  let authorized = false;
  for (const candidate of expected) {
    if (isAuthorized(headerValue, candidate)) authorized = true;
  }
  return authorized;
}
