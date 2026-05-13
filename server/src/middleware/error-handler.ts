import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { sanitizeErrorForLog, sanitizeLogRecord } from "../redaction.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: sanitizeLogRecord(payload) as ErrorContext["error"],
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body && typeof req.body === "object"
      ? sanitizeLogRecord(req.body as Record<string, unknown>)
      : req.body,
    reqParams: req.params && typeof req.params === "object"
      ? sanitizeLogRecord(req.params as Record<string, unknown>)
      : req.params,
    reqQuery: req.query && typeof req.query === "object"
      ? sanitizeLogRecord(req.query as Record<string, unknown>)
      : req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      const sanitized = sanitizeErrorForLog(err) as ErrorContext["error"];
      attachErrorContext(
        req,
        res,
        {
          message: sanitized.message ?? err.message,
          stack: sanitized.stack,
          name: sanitized.name,
          details: sanitized.details,
        },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  const sanitized = sanitizeErrorForLog(err) as ErrorContext["error"];
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? {
          message: sanitized.message ?? err.message,
          stack: sanitized.stack,
          name: sanitized.name,
        }
      : {
          message: sanitized.message ?? String(err),
          raw: sanitized.raw ?? sanitized,
          stack: sanitized.stack ?? rootError.stack,
          name: sanitized.name ?? rootError.name,
        },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({ error: "Internal server error" });
}
