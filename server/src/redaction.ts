import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|(?:^|[-_])token(?:$|[-_]))/i;
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE =
  /^-{1,2}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)$/i;
const JSON_SECRET_FIELD_TEXT_RE =
  /((?:"|')?(?:api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|\btoken\b)(?:"|')?\s*:\s*(?:"|'))[^"'`\r\n]+((?:"|'))/gi;
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE =
  /((?:\\")?(?:api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|\btoken\b)(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))/gi;
const URL_CREDENTIAL_TEXT_RE =
  /(\b[a-z][a-z0-9+.-]*:\/\/)([^:@\s/]+):([^@\s/]+)@/gi;
const URL_QUERY_SECRET_TEXT_RE =
  /([?&](?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret(?:[-_]?id)?|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|token)=)[^&#\s]+/gi;
const SECRET_REF_TEXT_RE =
  /\bsecret-ref:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

function sanitizeLogValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return sanitizeErrorForLog(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value === "string") return redactSensitiveText(value);
  if (isSecretRefBinding(value)) {
    return {
      type: "secret_ref",
      secretId: REDACTED_EVENT_VALUE,
      ...(value.version !== undefined ? { version: sanitizeLogValue(value.version) } : {}),
    };
  }
  if (isPlainBinding(value)) return { type: "plain", value: REDACTED_EVENT_VALUE };
  if (!isPlainObject(value)) return value;
  return sanitizeLogRecord(value);
}

export function sanitizeLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value).map(sanitizeLogValue);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = {
          type: "secret_ref",
          secretId: REDACTED_EVENT_VALUE,
          ...(value.version !== undefined ? { version: sanitizeLogValue(value.version) } : {}),
        };
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeLogValue(value);
  }
  return redacted;
}

function copyErrorProp(source: Error, key: string, target: Record<string, unknown>) {
  if (!(key in source)) return;
  const value = (source as unknown as Record<string, unknown>)[key];
  if (value === undefined) return;
  target[key] = SECRET_PAYLOAD_KEY_RE.test(key) ? REDACTED_EVENT_VALUE : sanitizeLogValue(value);
}

export function sanitizeErrorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    const sanitized: Record<string, unknown> = {
      name: redactSensitiveText(error.name),
      message: redactSensitiveText(error.message),
    };
    if (error.stack) sanitized.stack = redactSensitiveText(error.stack);
    for (const key of [
      "code",
      "status",
      "statusCode",
      "constraint",
      "constraint_name",
      "detail",
      "schema",
      "table",
      "column",
      "routine",
      "connectionString",
      "cause",
    ]) {
      copyErrorProp(error, key, sanitized);
    }
    return sanitized;
  }
  if (typeof error === "string") return redactSensitiveText(error);
  if (isPlainObject(error)) return sanitizeLogRecord(error);
  return error;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function redactSensitiveText(input: string): string {
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(URL_CREDENTIAL_TEXT_RE, `$1$2:${REDACTED_EVENT_VALUE}@`)
      .replace(URL_QUERY_SECRET_TEXT_RE, `$1${REDACTED_EVENT_VALUE}`)
      .replace(SECRET_REF_TEXT_RE, REDACTED_EVENT_VALUE),
    REDACTED_EVENT_VALUE,
  );
}
