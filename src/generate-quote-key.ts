import { randomBytes } from "node:crypto";

import { exportJWK, generateKeyPair } from "jose";

const suppliedKeyId = process.env.QUOTE_KEY_ID;
const keyId = suppliedKeyId?.trim() || `nq_${Date.now()}_${randomBytes(6).toString("base64url")}`;
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) {
  throw new Error("QUOTE_KEY_ID must contain 1-128 safe identifier characters.");
}

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});
const privateJwk = {
  ...(await exportJWK(privateKey)),
  kid: keyId,
  alg: "EdDSA",
  use: "sig",
};
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: keyId,
  alg: "EdDSA",
  use: "sig",
};

console.log(
  JSON.stringify(
    {
      warning: "Store privateJwk in the VPS secret configuration. Never commit it.",
      privateJwk,
      publicJwk,
    },
    null,
    2,
  ),
);
