/** Security primitives only. No public route, storage adapter or service activation. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { validateStacksAddress } from "@stacks/transactions";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { EvidenceIssuerBusy } from "./evidence-issuer-busy.js";

const networkSchema = z.enum(["testnet", "mainnet"]);
const uint = z.string().regex(/^[1-9][0-9]{0,38}$/).refine(n => BigInt(n) < 2n ** 128n);
const wallet = z.string().refine(validateStacksAddress);
const contextSchema = z.object({
  network: networkSchema, contract: z.string().max(170), jobId: uint, provider: wallet,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mediaType: z.enum(["text/plain", "application/json"]),
  sizeBytes: z.number().int().min(1).max(8192),
}).strict();
export type PrivateEvidenceContext = z.infer<typeof contextSchema>;
export type EvidenceScope = "evidence:read" | "evidence:write";
export type EvidenceIdentity = {
  readonly walletAddress: string; readonly clientId: string; readonly merchantId: string;
};
export class PrivateEvidenceDenied extends Error {
  constructor() { super("private_evidence_access_denied"); }
}
function requireSafe(ok: unknown): asserts ok { if (!ok) throw new PrivateEvidenceDenied(); }
function inNetwork(address: string, network: "testnet" | "mainnet") {
  return validateStacksAddress(address) && (network === "testnet" ? /^(ST|SN)/ : /^(SP|SM)/).test(address);
}
export function validateEvidenceContext(input: unknown): PrivateEvidenceContext {
  const result = contextSchema.safeParse(input); requireSafe(result.success);
  const c = result.data;
  const parts = c.contract.split(".");
  requireSafe(parts.length === 2 && inNetwork(parts[0]!, c.network) &&
    /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(parts[1]!) && inNetwork(c.provider, c.network));
  // Explicit canonical property order: never authenticate caller's JSON key order.
  return { network: c.network, contract: c.contract, jobId: c.jobId, provider: c.provider,
    sha256: c.sha256, mediaType: c.mediaType, sizeBytes: c.sizeBytes };
}
const context = validateEvidenceContext;

/** Caller must supply the trusted issuer's key resolver, not token-selected jwks_url/jku. */
export async function authenticateEvidence(input: {
  authorization: string | undefined; scope: EvidenceScope; network: "testnet" | "mainnet";
  issuer: string; audience: string; keys: JWTVerifyGetKey; now?: Date;
  /** Must check authoritative client/tenant activation; unavailable must throw/return false. */
  activeIdentity: (identity: EvidenceIdentity) => Promise<boolean>;
}): Promise<Readonly<EvidenceIdentity>> {
  try {
    requireSafe(input.scope === "evidence:read" || input.scope === "evidence:write");
    networkSchema.parse(input.network);
    const authorization = input.authorization;
    requireSafe(typeof authorization === "string" && authorization.startsWith("Bearer ") && authorization.length <= 8192);
    const token = authorization.slice(7);
    requireSafe(!token.startsWith("ny_mk_") && token.split(".").length === 3);
    const { payload, protectedHeader } = await jwtVerify(token, input.keys, {
      algorithms: ["EdDSA"], issuer: input.issuer, audience: input.audience,
      requiredClaims: ["exp", "iat", "sub", "client_id", "wallet_address", "scope"],
      maxTokenAge: "15 minutes", currentDate: input.now ?? new Date(),
    });
    requireSafe(protectedHeader.typ === "at+jwt" && !protectedHeader.jku && !protectedHeader.jwk);
    requireSafe(typeof payload.exp === "number" && typeof payload.iat === "number" &&
      payload.exp > payload.iat && payload.exp - payload.iat <= 900);
    requireSafe(typeof payload.wallet_address === "string" && inNetwork(payload.wallet_address, input.network));
    requireSafe(typeof payload.client_id === "string" && /^ny_oc_[A-Za-z0-9_-]{24}$/.test(payload.client_id));
    requireSafe(typeof payload.sub === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(payload.sub));
    requireSafe(typeof payload.scope === "string");
    const scopes = payload.scope.split(" ");
    requireSafe(scopes.every(Boolean) && new Set(scopes).size === scopes.length && scopes.includes(input.scope));
    const identity = Object.freeze({ walletAddress: payload.wallet_address, clientId: payload.client_id, merchantId: payload.sub });
    requireSafe(await input.activeIdentity(identity));
    return identity;
  } catch (error) {
    if (error instanceof EvidenceIssuerBusy) throw error;
    throw new PrivateEvidenceDenied();
  }
}

export interface PrivateEvidenceJob {
  readonly network: "testnet" | "mainnet"; readonly contract: string; readonly jobId: string;
  readonly client: string; readonly provider: string | null; readonly evaluator: string;
  readonly status: number; readonly escrow: bigint;
}
/** Fresh chain data must come from an allowlisted adapter, never request JSON or an LLM. */
export async function authorizeEvidence(input: {
  identity: EvidenceIdentity; scope: EvidenceScope; context: PrivateEvidenceContext;
  network: "testnet" | "mainnet"; allowedContracts: readonly string[];
  readJob: (contract: string, jobId: string) => Promise<PrivateEvidenceJob | null>;
}): Promise<"consumer" | "provider" | "evaluator"> {
  try {
    const c = context(input.context);
    requireSafe(c.network === input.network && input.allowedContracts.includes(c.contract));
    requireSafe(inNetwork(input.identity.walletAddress, c.network));
    requireSafe(input.scope === "evidence:read" || input.scope === "evidence:write");
    const job = await input.readJob(c.contract, c.jobId);
    requireSafe(job && job.network === c.network && job.contract === c.contract && job.jobId === c.jobId && job.provider === c.provider);
    requireSafe([job.client, job.provider, job.evaluator].every(a => inNetwork(a!, c.network)) &&
      new Set([job.client, job.provider, job.evaluator]).size === 3);
    requireSafe(Number.isInteger(job.status) && job.status >= 0 && job.status <= 8 && typeof job.escrow === "bigint" && job.escrow >= 0n);
    const actor = input.identity.walletAddress;
    if (input.scope === "evidence:write") {
      requireSafe(actor === job.provider && job.status === 1 && job.escrow > 0n);
      return "provider";
    }
    if (actor === job.client) return "consumer";
    if (actor === job.provider) return "provider";
    requireSafe(actor === job.evaluator && [2, 7, 8].includes(job.status) && job.escrow > 0n);
    return "evaluator";
  } catch { throw new PrivateEvidenceDenied(); }
}

const envelopeSchema = z.object({ version: z.literal(1), keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  iv: z.string().regex(/^[0-9a-f]{24}$/), tag: z.string().regex(/^[0-9a-f]{32}$/),
  ciphertext: z.string().min(4).max(10924).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type EncryptedEvidence = z.infer<typeof envelopeSchema>;
function verifyBytes(bytes: Uint8Array, c: PrivateEvidenceContext) {
  requireSafe(bytes.length === c.sizeBytes && createHash("sha256").update(bytes).digest("hex") === c.sha256);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (c.mediaType === "application/json") JSON.parse(text);
}
function aad(c: PrivateEvidenceContext, keyId: string) {
  return Buffer.from(JSON.stringify({ purpose: "nayori-private-evidence", version: 1, keyId, ...c }));
}
/** Encryption is not authorization. The HTTP service must authenticate/authorize EVERY read. */
export function sealEvidence(bytes: Uint8Array, expected: PrivateEvidenceContext, keyId: string, key: Uint8Array): EncryptedEvidence {
  try {
    const c = context(expected); requireSafe(key.length === 32 && /^[a-zA-Z0-9_-]{1,64}$/.test(keyId));
    verifyBytes(bytes, c);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(c, keyId));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { version: 1, keyId, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") };
  } catch { throw new PrivateEvidenceDenied(); }
}
export function openEvidence(envelope: unknown, expected: PrivateEvidenceContext, keyId: string, key: Uint8Array): Buffer {
  try {
    const c = context(expected), sealed = envelopeSchema.parse(envelope);
    requireSafe(key.length === 32 && sealed.keyId === keyId);
    const ciphertext = Buffer.from(sealed.ciphertext, "base64");
    requireSafe(ciphertext.toString("base64") === sealed.ciphertext && ciphertext.length === c.sizeBytes);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "hex"));
    decipher.setAAD(aad(c, keyId)); decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    verifyBytes(bytes, c); return bytes;
  } catch { throw new PrivateEvidenceDenied(); }
}
