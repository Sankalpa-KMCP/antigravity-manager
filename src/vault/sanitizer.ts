/**
 * Centralized secret redaction and sanitization logic.
 * Ensures no sensitive tokens, passwords, cookies, or secrets appear in logs or errors.
 */

const REDACTED_MARKER = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS = [
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /id[_-]?token/i,
  /authorization/i,
  /auth[_-]?header/i,
  /cookie/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /csrf[_-]?token/i,
  /credential/i,
  /private[_-]?key/i,
  /api[_-]?key/i
];

/**
 * Checks whether a given property/key name represents a sensitive credential.
 */
export function isSensitiveKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Recursively sanitizes an arbitrary object, array, or primitive.
 * Returns a deep copy with sensitive values replaced by '[REDACTED]'.
 * Does NOT mutate the source object.
 */
export function sanitizeObject<T>(obj: T, seen = new WeakSet()): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj) as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle Error instances
  if (obj instanceof Error) {
    const sanitizedError: Record<string, any> = {
      name: obj.name,
      message: sanitizeString(obj.message),
      stack: obj.stack ? sanitizeString(obj.stack) : undefined
    };
    return sanitizedError as unknown as T;
  }

  // Handle Buffer
  if (Buffer.isBuffer(obj)) {
    return `[Buffer (${obj.length} bytes)]` as unknown as T;
  }

  // Prevent circular references
  if (seen.has(obj as object)) {
    return '[Circular]' as unknown as T;
  }
  seen.add(obj as object);

  // Handle Arrays
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, seen)) as unknown as T;
  }

  // Handle standard objects
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED_MARKER;
    } else {
      result[key] = sanitizeObject(value, seen);
    }
  }

  return result as T;
}

/**
 * Sanitizes sensitive patterns out of raw strings (such as URLs, HTTP headers, or formatted JSON).
 */
export function sanitizeString(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let sanitized = text;

  // Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.+=~]{8,}/gi, 'Bearer [REDACTED]');

  // Redact Google OAuth access token strings (ya29...)
  sanitized = sanitized.replace(/ya29\.[A-Za-z0-9_\-\.+=~]{8,}/gi, '[REDACTED]');

  // Redact Google OAuth refresh token strings (1//...)
  sanitized = sanitized.replace(/1\/\/[A-Za-z0-9_\-\.+=~]{8,}/gi, '[REDACTED]');

  // Redact key=value or key:value style assignments (quoted and unquoted)
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    // Matches "key": "secret", key: "secret", key="secret", key='secret'
    const quotedRegex = new RegExp(`("${pattern.source}"|${pattern.source})(\\s*[:=]\\s*)(["'])(.*?)(["'])`, 'gi');
    sanitized = sanitized.replace(quotedRegex, `$1$2$3${REDACTED_MARKER}$5`);

    // Matches unquoted key=secret or key: secret in URLs, query strings, or logs
    const unquotedRegex = new RegExp(`(${pattern.source}\\s*[=:]\\s*)([^\r\n&\\s"']+)`, 'gi');
    sanitized = sanitized.replace(unquotedRegex, `$1${REDACTED_MARKER}`);
  }

  return sanitized;
}

/**
 * Safely stringifies an object to JSON with full recursive redaction applied.
 */
export function safeJsonStringify(data: any, space?: number): string {
  const sanitized = sanitizeObject(data);
  return JSON.stringify(sanitized, null, space);
}

/**
 * Safe logging helper that sanitizes all arguments before writing to stdout/stderr.
 */
export function safeLog(...args: any[]): void {
  const sanitized = args.map(arg => {
    if (typeof arg === 'string') {
      return sanitizeString(arg);
    }
    return sanitizeObject(arg);
  });
  console.log(...sanitized);
}

export function safeError(...args: any[]): void {
  const sanitized = args.map(arg => {
    if (typeof arg === 'string') {
      return sanitizeString(arg);
    }
    return sanitizeObject(arg);
  });
  console.error(...sanitized);
}
