import type { HttpRequest } from './types.js';

/**
 * Reads a JSON body, whatever shape the platform hands it in.
 *
 * Vercel parses `application/json` for you and leaves a string for everything
 * else, so a route cannot assume either. Shared rather than copied because two
 * routes now accept the same body and a validation rule living in two files is a
 * rule that will eventually disagree with itself.
 */
export function readJsonBody(req: HttpRequest): Record<string, unknown> {
  const raw = (req as { body?: unknown }).body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('body is not valid JSON');
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  throw new Error('body is not valid JSON');
}
