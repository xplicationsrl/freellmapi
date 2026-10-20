// Typed reads of the few fields code looks at on a caught value.
//
// `catch (err)` hands over `unknown`, and providers, fetch and our own error
// classes all throw different shapes: an Error, an Error with a `status` or
// `code` bolted on, sometimes a bare string. These helpers answer "what is the
// message / status / code, if it has one?" without casting to `any`, and they
// never throw on a null, a number or a frozen object.

export interface ErrorProps {
  message?: string;
  name?: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
}

function field(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined;
}

/** The message of a caught value: its own `message` string, else `fallback`, else String(err). */
export function errorMessage(err: unknown, fallback?: string): string {
  const message = field(err, 'message');
  if (typeof message === 'string') return message;
  if (fallback !== undefined) return fallback;
  if (typeof err === 'string') return err;
  return String(err);
}

/** The `status`, `code`, `name`, `message` and `retryAfterMs` of a caught value, each only if it has the right type. */
export function errorProps(err: unknown): ErrorProps {
  const message = field(err, 'message');
  const name = field(err, 'name');
  const status = field(err, 'status');
  const code = field(err, 'code');
  const retryAfterMs = field(err, 'retryAfterMs');
  return {
    message: typeof message === 'string' ? message : undefined,
    name: typeof name === 'string' ? name : undefined,
    status: typeof status === 'number' ? status : undefined,
    code: typeof code === 'string' ? code : undefined,
    retryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : undefined,
  };
}
