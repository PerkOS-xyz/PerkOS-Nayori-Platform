import { hashMessage } from "@stacks/encryption";
import {
  privateKeyToPublic,
  publicKeyToAddressSingleSig,
  randomPrivateKey,
  signMessageHashRsv,
} from "@stacks/transactions";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { MerchantAuthenticationError, type OAuthScope } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type {
  IssuedQuoteRecord,
  OAuthClientRecord,
  PartnerInvitationRecord,
  WalletAuthChallengeRecord,
} from "../src/database.js";
import type { MerchantRecord } from "../src/merchant.js";
import {
  createInvitationRecord,
  createOAuthService,
  createOAuthSigner,
  hashPartnerInvitationToken,
} from "../src/oauth.js";

const NOW = 1_800_000_000_000;
const merchant: MerchantRecord = {
  merchantId: "partner-merchant",
  allowedOrigins: ["https://partner.example"],
  allowedAudiences: ["partner:api"],
  recipientAllowlist: ["ST000000000000000000002AMW42H"],
  routeConfig: {
    version: 1,
    routes: {
      api: {
        method: "POST",
        pathPrefix: "/api",
        audience: "partner:api",
        network: "testnet",
        asset: "stx",
        amount: "1",
        payTo: "ST000000000000000000002AMW42H",
        ttlSeconds: 60,
      },
    },
  },
};

class MemoryAuthStore {
  invitation: (PartnerInvitationRecord & { tokenDigest: string; used?: boolean }) | null = null;
  challenge: (WalletAuthChallengeRecord & { used?: boolean }) | null = null;
  client: OAuthClientRecord | null = null;
  tokenIssuedAt: Date | null = null;

  async findActiveMerchantByApiKeyHash(): Promise<MerchantRecord | null> {
    return null;
  }
  async findActiveMerchantById(merchantId: string): Promise<MerchantRecord | null> {
    return merchantId === merchant.merchantId ? merchant : null;
  }
  async insertIssuedQuote(record: IssuedQuoteRecord): Promise<void> {
    void record;
  }
  async findActivePartnerInvitation(tokenDigest: string, now: Date) {
    return this.invitation &&
      !this.invitation.used &&
      this.invitation.tokenDigest === tokenDigest &&
      this.invitation.expiresAt >= now
      ? this.invitation
      : null;
  }
  async insertWalletAuthChallenge(input: WalletAuthChallengeRecord): Promise<void> {
    this.challenge = input;
  }
  async findActiveWalletAuthChallenge(challengeId: string, now: Date) {
    return this.challenge &&
      !this.challenge.used &&
      this.challenge.challengeId === challengeId &&
      this.challenge.challengeExpiresAt >= now &&
      this.challenge.expiresAt >= now
      ? this.challenge
      : null;
  }
  async consumeChallengeAndCreateOAuthClient(input: {
    challengeId: string;
    clientId: string;
    secretDigest: string;
    usedAt: Date;
  }) {
    if (!this.challenge || this.challenge.used || this.challenge.challengeId !== input.challengeId) {
      return null;
    }
    this.challenge.used = true;
    if (this.invitation) this.invitation.used = true;
    this.client = {
      clientId: input.clientId,
      merchantId: this.challenge.merchantId,
      walletAddress: this.challenge.walletAddress,
      secretDigest: input.secretDigest,
      scopes: this.challenge.scopes,
    };
    return this.client;
  }
  async findActiveOAuthClient(clientId: string) {
    return this.client?.clientId === clientId ? this.client : null;
  }
  async recordOAuthTokenIssued(_clientId: string, issuedAt: Date): Promise<void> {
    this.tokenIssuedAt = issuedAt;
  }
}

async function context(scopes: OAuthScope[] = ["quotes:create", "mcp:invoke"]) {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = {
    ...(await exportJWK(privateKey)),
    kid: "oauth-test",
    alg: "EdDSA",
    use: "sig",
  };
  const config = loadConfig({
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    NODE_ENV: "test",
    SERVICE_ORIGIN: "https://api.nayori.ai",
    STACKS_NETWORK: "testnet",
    OAUTH_ENABLED: "true",
    PARTNER_REGISTRATION_ENABLED: "true",
    OAUTH_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(privateJwk),
    OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120",
  });
  const signer = await createOAuthSigner(config);
  const store = new MemoryAuthStore();
  const invitation = createInvitationRecord({
    merchantId: merchant.merchantId,
    scopes,
    expiresAt: new Date(NOW + 60_000),
  });
  store.invitation = { ...invitation.record, tokenDigest: hashPartnerInvitationToken(invitation.token) };
  const service = createOAuthService({ config, store, signer, now: () => NOW });
  return { config, invitation, service, store };
}

async function registerWallet(service: Awaited<ReturnType<typeof context>>["service"], token: string) {
  const privateKey = randomPrivateKey();
  const publicKey = privateKeyToPublic(privateKey);
  const publicKeyHex = typeof publicKey === "string" ? publicKey : Buffer.from(publicKey).toString("hex");
  const walletAddress = publicKeyToAddressSingleSig(publicKey, "testnet");
  const challenge = await service.issueChallenge({ invitationToken: token, walletAddress });
  const signature = signMessageHashRsv({
    messageHash: Buffer.from(hashMessage(challenge.message)).toString("hex"),
    privateKey,
  });
  const client = await service.register({
    challengeId: challenge.challengeId,
    signature: `0x${signature}`,
    publicKey: `0x${publicKeyHex}`,
  });
  return { challenge, client, walletAddress, signature, publicKeyHex };
}

describe("wallet-linked OAuth partner enrollment", () => {
  it("consumes a signed invitation and issues a scoped short-lived access token", async () => {
    const { invitation, service, store } = await context();
    const registration = await registerWallet(service, invitation.token);
    const basic = Buffer.from(`${registration.client.clientId}:${registration.client.clientSecret}`).toString("base64");
    const token = await service.issueToken(
      `Basic ${basic}`,
      new URLSearchParams({ grant_type: "client_credentials", scope: "quotes:create" }),
    );

    expect(registration.client).toMatchObject({
      walletAddress: registration.walletAddress,
      tokenEndpoint: "https://api.nayori.ai/oauth/token",
      scopes: ["quotes:create", "mcp:invoke"],
    });
    expect(token).toMatchObject({ token_type: "Bearer", expires_in: 120, scope: "quotes:create" });
    await expect(service.authenticate(`Bearer ${token.access_token}`, "quotes:create")).resolves.toEqual(merchant);
    await expect(service.authenticate(`Bearer ${token.access_token}`, "mcp:invoke")).rejects.toBeInstanceOf(
      MerchantAuthenticationError,
    );
    expect(store.tokenIssuedAt?.toISOString()).toBe(new Date(NOW).toISOString());
  });

  it("rejects challenge replay and a signature from a different wallet", async () => {
    const first = await context();
    const registered = await registerWallet(first.service, first.invitation.token);
    await expect(
      first.service.register({
        challengeId: registered.challenge.challengeId,
        signature: registered.signature,
        publicKey: registered.publicKeyHex,
      }),
    ).rejects.toMatchObject({ code: "invalid_challenge" });

    const second = await context();
    const privateKey = randomPrivateKey();
    const walletAddress = publicKeyToAddressSingleSig(privateKeyToPublic(privateKey), "testnet");
    const challenge = await second.service.issueChallenge({
      invitationToken: second.invitation.token,
      walletAddress,
    });
    const attackerKey = randomPrivateKey();
    await expect(
      second.service.register({
        challengeId: challenge.challengeId,
        signature: signMessageHashRsv({
          messageHash: Buffer.from(hashMessage(challenge.message)).toString("hex"),
          privateKey: attackerKey,
        }),
        publicKey: privateKeyToPublic(attackerKey),
      }),
    ).rejects.toMatchObject({ code: "invalid_wallet_signature" });
  });

  it("rejects an invalid client secret and over-broad scope request", async () => {
    const { invitation, service } = await context(["quotes:create"]);
    const { client } = await registerWallet(service, invitation.token);
    const wrong = Buffer.from(`${client.clientId}:ny_cs_${"A".repeat(43)}`).toString("base64");
    await expect(
      service.issueToken(`Basic ${wrong}`, new URLSearchParams({ grant_type: "client_credentials" })),
    ).rejects.toMatchObject({ code: "invalid_client" });

    const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
    await expect(
      service.issueToken(
        `Basic ${basic}`,
        new URLSearchParams({ grant_type: "client_credentials", scope: "payments:settle" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});
