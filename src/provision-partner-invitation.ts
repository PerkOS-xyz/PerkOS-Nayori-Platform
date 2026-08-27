import { oauthScopes, type OAuthScope } from "./auth.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { createInvitationRecord } from "./oauth.js";

const merchantId = process.env.PARTNER_MERCHANT_ID?.trim();
if (!merchantId) throw new Error("PARTNER_MERCHANT_ID is required.");

const requestedScopes = (process.env.PARTNER_SCOPES ?? "")
  .split(" ")
  .map((scope) => scope.trim())
  .filter(Boolean);
if (
  requestedScopes.length === 0 ||
  new Set(requestedScopes).size !== requestedScopes.length ||
  requestedScopes.some((scope) => !oauthScopes.includes(scope as OAuthScope))
) {
  throw new Error(`PARTNER_SCOPES must be a unique space-separated subset of: ${oauthScopes.join(" ")}`);
}

const ttlSeconds = Number(process.env.PARTNER_INVITATION_TTL_SECONDS ?? "86400");
if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604_800) {
  throw new Error("PARTNER_INVITATION_TTL_SECONDS must be an integer between 300 and 604800.");
}

const config = loadConfig();
const database = new PostgresDatabase(config);
try {
  const merchant = await database.findActiveMerchantById(merchantId);
  if (!merchant) throw new Error("The active merchant does not exist.");
  const invitation = createInvitationRecord({
    merchantId,
    scopes: requestedScopes as OAuthScope[],
    expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
  });
  await database.insertPartnerInvitation(invitation.record);
  console.log(
    JSON.stringify(
      {
        warning: "This invitation token is shown once. Send it to the partner over a private channel.",
        invitationToken: invitation.token,
        merchantId,
        scopes: requestedScopes,
        expiresAt: invitation.record.expiresAt.toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
