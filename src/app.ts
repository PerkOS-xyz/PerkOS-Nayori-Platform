import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import type { AppConfig } from "./config.js";
import type { DatabaseHealth } from "./database.js";
import {
  createAgentDocument,
  createAuthMarkdown,
  createLlmsText,
  createMcpServerCard,
  createOpenApiDocument,
  createOAuthAuthorizationServerMetadata,
  createOAuthProtectedResourceMetadata,
  createSupportedDocument,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./documents.js";
import type { AppLogger } from "./logger.js";
import { McpAuthenticationError, type McpService } from "./mcp.js";
import { OAuthServiceError, type OAuthService } from "./oauth.js";
import { QuoteServiceError, type QuoteService } from "./quotes.js";
import { SettlementServiceError, type SettlementService } from "./settlement.js";

type AppVariables = {
  requestId: string;
};

export type CreateAppOptions = {
  readonly config: AppConfig;
  readonly database: DatabaseHealth;
  readonly logger: AppLogger;
  readonly quoteService?: QuoteService;
  readonly settlementService?: SettlementService;
  readonly oauthService?: OAuthService;
  readonly mcpService?: McpService;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SHA256_DIGEST = /^[0-9a-f]{64}$/;

function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } } as const;
}

function bearerChallenge(config: AppConfig, realm: string, scope?: string): string {
  const metadata = config.oauthEnabled
    ? `, resource_metadata="${config.oauthResourceOrigin}/.well-known/oauth-protected-resource"`
    : "";
  const oauthError = scope ? `, error="insufficient_scope", scope="${scope}"` : "";
  return `Bearer realm="${realm}"${metadata}${oauthError}`;
}

export function createApp(options: CreateAppOptions): Hono<{ Variables: AppVariables }> {
  const { config, database, logger, quoteService, settlementService, oauthService, mcpService } = options;
  if (config.quoteIssuanceEnabled && !quoteService) {
    throw new Error("Quote issuance is enabled without a quote service.");
  }
  if (config.paymentVerificationEnabled && !settlementService) {
    throw new Error("Payment verification is enabled without a settlement service.");
  }
  if (config.oauthEnabled && config.oauthMode === "embedded" && !oauthService) {
    throw new Error("Embedded OAuth is enabled without an OAuth service.");
  }
  if (config.mcpEnabled && !mcpService) {
    throw new Error("MCP is enabled without an MCP service.");
  }
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
  app.use(
    "/oauth/*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) =>
        context.json(
          errorBody("request_too_large", "The request body exceeds the 16 KiB limit.", context.get("requestId")),
          413,
        ),
    }),
  );
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          errorBody("request_too_large", "The request body exceeds the 64 KiB limit.", context.get("requestId")),
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

  if (config.oauthEnabled) {
    app.get("/.well-known/oauth-authorization-server", (context) => {
      if (config.oauthMode === "external") {
        return context.redirect(
          `${config.oauthIssuerOrigin}/.well-known/oauth-authorization-server`,
          308,
        );
      }
      return context.json(createOAuthAuthorizationServerMetadata(config));
    });
    app.get("/.well-known/oauth-protected-resource", (context) =>
      context.json(createOAuthProtectedResourceMetadata(config)),
    );
    app.get("/auth.md", (context) => context.text(createAuthMarkdown(config), 200, {
      "content-type": "text/markdown; charset=UTF-8",
    }));

    if (config.oauthMode === "external") {
      app.get("/oauth/jwks.json", (context) => context.redirect(config.oauthJwksUri, 308));
    } else if (oauthService) {
      app.get("/oauth/jwks.json", (context) => context.json(oauthService.publicJwks));
      app.post("/oauth/token", async (context) => {
        try {
          const form = new URLSearchParams(await context.req.text());
          return context.json(
            await oauthService.issueToken(context.req.header("authorization"), form),
          );
        } catch (error) {
          if (!(error instanceof OAuthServiceError)) throw error;
          if (error.status === 401) {
            context.header("www-authenticate", 'Basic realm="nayori-oauth"');
          }
          return context.json(
            {
              error: error.code,
              error_description: error.publicMessage,
              request_id: context.get("requestId"),
            },
            error.status,
          );
        }
      });

      if (config.partnerRegistrationEnabled) {
        app.post("/v1/partners/challenges", async (context) => {
          let input: unknown;
          try {
            input = await context.req.json();
          } catch {
            return context.json(
              errorBody("invalid_request", "The partner challenge must be valid JSON.", context.get("requestId")),
              400,
            );
          }
          try {
            return context.json({ challenge: await oauthService.issueChallenge(input) }, 201);
          } catch (error) {
            if (!(error instanceof OAuthServiceError)) throw error;
            return context.json(errorBody(error.code, error.publicMessage, context.get("requestId")), error.status);
          }
        });
        app.post("/v1/partners/register", async (context) => {
          let input: unknown;
          try {
            input = await context.req.json();
          } catch {
            return context.json(
              errorBody("invalid_request", "The partner registration must be valid JSON.", context.get("requestId")),
              400,
            );
          }
          try {
            return context.json({ client: await oauthService.register(input) }, 201);
          } catch (error) {
            if (!(error instanceof OAuthServiceError)) throw error;
            return context.json(errorBody(error.code, error.publicMessage, context.get("requestId")), error.status);
          }
        });
      }
    }
  }

  if (config.mcpEnabled && mcpService) {
    app.get("/.well-known/mcp/server-card.json", (context) =>
      context.json(createMcpServerCard(config)),
    );
    app.get("/.well-known/mcp.json", (context) => context.json(createMcpServerCard(config)));
    app.post("/mcp", async (context) => {
      let input: unknown;
      try {
        input = await context.req.json();
      } catch {
        return context.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      try {
        return context.json(await mcpService.handle(context.req.header("authorization"), input));
      } catch (error) {
        if (!(error instanceof McpAuthenticationError)) throw error;
        const scope = error.code === "insufficient_scope" ? ', error="insufficient_scope", scope="mcp:invoke"' : "";
        context.header(
          "www-authenticate",
          `Bearer resource_metadata="${config.oauthResourceOrigin}/.well-known/oauth-protected-resource"${scope}`,
        );
        return context.json(errorBody(error.code, "A bearer token with mcp:invoke is required.", context.get("requestId")), error.code === "insufficient_scope" ? 403 : 401);
      }
    });
  }

  if (config.quoteIssuanceEnabled && quoteService) {
    app.get("/.well-known/jwks.json", (context) => context.json(quoteService.publicJwks));
    app.post("/v1/quotes", async (context) => {
      let input: unknown;
      try {
        input = await context.req.json();
      } catch {
        return context.json(
          errorBody("invalid_request", "The quote request must be valid JSON.", context.get("requestId")),
          400,
        );
      }

      try {
        const issued = await quoteService.issue(context.req.header("authorization"), input);
        logger.info({
          event: "quote_issued",
          requestId: context.get("requestId"),
          merchantId: issued.merchantId,
          routeId: issued.routeId,
          quoteId: issued.quoteId,
        });
        return context.json(issued.response, 201);
      } catch (error) {
        if (!(error instanceof QuoteServiceError)) throw error;
        if (error.status === 401 || error.code === "insufficient_scope") {
          context.header(
            "www-authenticate",
            bearerChallenge(config, "nayori-quotes", error.code === "insufficient_scope" ? "quotes:create" : undefined),
          );
        }
        if (error.status === 429 && error.retryAfterSeconds) {
          context.header("retry-after", String(error.retryAfterSeconds));
        }
        return context.json(
          errorBody(error.code, error.publicMessage, context.get("requestId")),
          error.status,
        );
      }
    });
  }

  if (config.paymentVerificationEnabled && settlementService) {
    app.post("/v1/x402/verify", async (context) => {
      let input: unknown;
      try {
        input = await context.req.json();
      } catch {
        return context.json(
          errorBody("invalid_request", "The payment request must be valid JSON.", context.get("requestId")),
          400,
        );
      }
      try {
        const verification = await settlementService.verify(
          context.req.header("authorization"),
          input,
        );
        logger.info({
          event: "payment_verified",
          requestId: context.get("requestId"),
          merchantId: verification.merchantId,
          quoteId: verification.quoteId,
          txid: verification.txid,
        });
        return context.json({ verification });
      } catch (error) {
        if (!(error instanceof SettlementServiceError)) throw error;
        if (error.status === 401 || error.code === "insufficient_scope") {
          context.header(
            "www-authenticate",
            bearerChallenge(config, "nayori-settlement", error.code === "insufficient_scope" ? "payments:verify" : undefined),
          );
        }
        if (error.status === 429 && error.retryAfterSeconds) {
          context.header("retry-after", String(error.retryAfterSeconds));
        }
        return context.json(
          errorBody(error.code, error.publicMessage, context.get("requestId")),
          error.status,
        );
      }
    });

    if (config.settlementEnabled) {
      app.post("/v1/x402/settle", async (context) => {
        let input: unknown;
        try {
          input = await context.req.json();
        } catch {
          return context.json(
            errorBody("invalid_request", "The payment request must be valid JSON.", context.get("requestId")),
            400,
          );
        }
        try {
          const result = await settlementService.settle(
            context.req.header("authorization"),
            input,
          );
          logger.info({
            event: "settlement_reserved",
            requestId: context.get("requestId"),
            settlementId: result.settlement.settlementId,
            quoteId: result.settlement.quoteId,
            txid: result.settlement.txid,
            status: result.settlement.status,
            replayed: result.replayed,
          });
          return context.json(
            result,
            result.settlement.status === "failed" ? 422 : 202,
          );
        } catch (error) {
          if (!(error instanceof SettlementServiceError)) throw error;
          if (error.status === 401 || error.code === "insufficient_scope") {
            context.header(
              "www-authenticate",
              bearerChallenge(config, "nayori-settlement", error.code === "insufficient_scope" ? "payments:settle" : undefined),
            );
          }
          if (error.status === 429 && error.retryAfterSeconds) {
            context.header("retry-after", String(error.retryAfterSeconds));
          }
          return context.json(
            errorBody(error.code, error.publicMessage, context.get("requestId")),
            error.status,
          );
        }
      });

      app.get("/v1/x402/settlements/:id", async (context) => {
        try {
          const settlement = await settlementService.get(
            context.req.header("authorization"),
            context.req.param("id"),
          );
          return context.json({ settlement });
        } catch (error) {
          if (!(error instanceof SettlementServiceError)) throw error;
          if (error.status === 401 || error.code === "insufficient_scope") {
            context.header(
              "www-authenticate",
              bearerChallenge(config, "nayori-settlement", error.code === "insufficient_scope" ? "payments:read" : undefined),
            );
          }
          if (error.status === 429 && error.retryAfterSeconds) {
            context.header("retry-after", String(error.retryAfterSeconds));
          }
          return context.json(
            errorBody(error.code, error.publicMessage, context.get("requestId")),
            error.status,
          );
        }
      });

      if (config.deliveryLedgerEnabled) {
        app.post("/v1/x402/settlements/:id/delivery/claim", async (context) => {
          try {
            const delivery = await settlementService.claimDelivery(
              context.req.header("authorization"),
              context.req.param("id"),
            );
            logger.info({
              event: "delivery_claimed",
              requestId: context.get("requestId"),
              settlementId: delivery.settlementId,
              deliveryId: delivery.deliveryId,
              status: delivery.status,
            });
            return context.json({ delivery });
          } catch (error) {
            if (!(error instanceof SettlementServiceError)) throw error;
            if (error.status === 401 || error.code === "insufficient_scope") {
              context.header(
                "www-authenticate",
                bearerChallenge(config, "nayori-settlement", error.code === "insufficient_scope" ? "payments:read" : undefined),
              );
            }
            if (error.status === 429 && error.retryAfterSeconds) {
              context.header("retry-after", String(error.retryAfterSeconds));
            }
            return context.json(
              errorBody(error.code, error.publicMessage, context.get("requestId")),
              error.status,
            );
          }
        });

        app.post("/v1/x402/settlements/:id/delivery/complete", async (context) => {
          let input: unknown;
          try {
            input = await context.req.json();
          } catch {
            return context.json(
              errorBody(
                "invalid_request",
                "The delivery completion must be valid JSON.",
                context.get("requestId"),
              ),
              400,
            );
          }
          const responseDigest =
            typeof input === "object" &&
            input !== null &&
            !Array.isArray(input) &&
            Object.keys(input).length === 1 &&
            "responseDigest" in input &&
            typeof input.responseDigest === "string" &&
            SHA256_DIGEST.test(input.responseDigest)
              ? input.responseDigest
              : null;
          if (!responseDigest) {
            return context.json(
              errorBody(
                "invalid_request",
                "responseDigest must be a lowercase SHA-256 digest.",
                context.get("requestId"),
              ),
              400,
            );
          }
          try {
            const delivery = await settlementService.completeDelivery(
              context.req.header("authorization"),
              context.req.param("id"),
              responseDigest,
            );
            logger.info({
              event: "delivery_completed",
              requestId: context.get("requestId"),
              settlementId: delivery.settlementId,
              deliveryId: delivery.deliveryId,
              responseDigest,
            });
            return context.json({ delivery });
          } catch (error) {
            if (!(error instanceof SettlementServiceError)) throw error;
            if (error.status === 401 || error.code === "insufficient_scope") {
              context.header(
                "www-authenticate",
                bearerChallenge(config, "nayori-settlement", error.code === "insufficient_scope" ? "payments:settle" : undefined),
              );
            }
            if (error.status === 429 && error.retryAfterSeconds) {
              context.header("retry-after", String(error.retryAfterSeconds));
            }
            return context.json(
              errorBody(error.code, error.publicMessage, context.get("requestId")),
              error.status,
            );
          }
        });
      }
    }
  }

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
