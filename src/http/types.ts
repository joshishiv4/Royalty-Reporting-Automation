/**
 * Minimal structural types for the Vercel Node runtime.
 *
 * Declared locally rather than depending on @vercel/node: these few members are
 * all the handlers touch, and a types-only dependency on the platform is not
 * worth carrying for them. Shared by every route so the shape is declared once.
 */

export interface HttpRequest {
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}
