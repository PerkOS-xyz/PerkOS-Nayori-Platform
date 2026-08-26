import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import type { AppConfig } from "./config.js";
import type { DatabaseHealth } from "./database.js";
import {
  createAgentDocument,
  createLlmsText,
  createOpenApiDocument,
  createSupportedDocument,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./documents.js";
import type { AppLogger } from "./logger.js";

type AppVariables = {
  requestId: string;
};

export type CreateAppOptions = {
  readonly config: AppConfig;
  readonly database: DatabaseHealth;
  readonly logger: AppLogger;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } } as const;
}

export function createApp(options: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const { config, database, logger } = options;
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    const startedAt = performance.now();

    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    context.header("x-service-release", config.releaseSha);

    try {
      await next();
    } finally {
      logger.info({
        event: "http_request",
        requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    }
  });

  app.use(
    "*",
    secureHeaders({
      permissionsPolicy: {
        camera: false,
        geolocation: false,
        microphone: false,
      },
      referrerPolicy: "no-referrer",
      strictTransportSecurity: "max-age=31536000",
      xFrameOptions: "DENY",
    }),
  );

  app.use("*", async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
  });

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          errorBody(
            "request_too_large",
            "The request body exceeds the 64 KiB limit.",
            context.get("requestId"),
          ),
          413,
        ),
    }),
  );

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      release: config.releaseSha,
    }),
  );

  app.get("/ready", async (context) => {
    try {
      await database.ping();
      return context.json({
        status: "ready",
        service: SERVICE_NAME,
        database: "available",
        release: config.releaseSha,
      });
    } catch {
      return context.json(
        {
          status: "not_ready",
          service: SERVICE_NAME,
          database: "unavailable",
          release: config.releaseSha,
        },
        503,
      );
    }
  });

  app.get("/supported", (context) => context.json(createSupportedDocument(config)));
  app.get("/x402.json", (context) => context.json(createSupportedDocument(config)));
  app.get("/.well-known/agent.json", (context) => context.json(createAgentDocument(config)));
  app.get("/openapi.json", (context) => context.json(createOpenApiDocument(config)));
  app.get("/llms.txt", (context) => context.text(createLlmsText(config)));

  app.notFound((context) =>
    context.json(
      errorBody("not_found", "The requested route does not exist.", context.get("requestId")),
      404,
    ),
  );

  app.onError((error, context) => {
    const requestId = context.get("requestId") || randomUUID();
    logger.error({ event: "unhandled_error", requestId, errorName: error.name });
    return context.json(
      errorBody("internal_error", "The service could not complete the request.", requestId),
      500,
    );
  });

  return app;
}
