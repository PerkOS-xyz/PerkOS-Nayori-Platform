import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { PostgresDatabase } from "../src/database.js";
import { generateMerchantApiKey, hashMerchantApiKey } from "../src/merchant.js";

const runIntegration = process.env.DATABASE_INTEGRATION === "true";
const PAY_TO = "ST1THWXQ8368SDN2MJGE4BMDKMCHZ2GSVTSQDA7QF";

describe.skipIf(!runIntegration)("PostgreSQL merchant quote store", () => {
  it("provisions, rotates and persists an issued quote", async () => {
    const config = loadConfig();
    const database = new PostgresDatabase(config);
    const firstKey = generateMerchantApiKey();
    const secondKey = generateMerchantApiKey();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 120_000);
    const provisioning = {
      merchantId: "integration-merchant",
      status: "active" as const,
      allowedOrigins: ["https://merchant.example"],
      allowedAudiences: ["merchant:integration"],
      recipientAllowlist: [PAY_TO],
      routeConfig: {
        version: 1 as const,
        routes: {
          integration: {
            method: "POST",
            pathPrefix: "/v1/integration",
            audience: "merchant:integration",
            network: "testnet" as const,
            asset: "sbtc" as const,
            amount: "1000",
            payTo: PAY_TO,
            ttlSeconds: 120,
          },
        },
      },
    };

    try {
      await database.provisionMerchant(provisioning, hashMerchantApiKey(firstKey));
      expect(
        await database.findActiveMerchantByApiKeyHash(hashMerchantApiKey(firstKey)),
      ).toMatchObject({ merchantId: "integration-merchant" });

      await database.provisionMerchant(provisioning, hashMerchantApiKey(secondKey));
      expect(await database.findActiveMerchantByApiKeyHash(hashMerchantApiKey(firstKey))).toBeNull();
      expect(
        await database.findActiveMerchantByApiKeyHash(hashMerchantApiKey(secondKey)),
      ).toMatchObject({ merchantId: "integration-merchant" });

      await database.insertIssuedQuote({
        quoteId: "integration-quote",
        merchantId: "integration-merchant",
        audience: "merchant:integration",
        requestMethod: "POST",
        canonicalUrl: "https://merchant.example/v1/integration",
        bodyHash: "a".repeat(64),
        network: "stacks:2147483648",
        assetId: "stacks:2147483648/slip44:0",
        amountAtomic: "1000",
        payTo: PAY_TO,
        fingerprint: `ny1_${"a".repeat(27)}`,
        routeConfigHash: "b".repeat(64),
        signedTokenHash: "c".repeat(64),
        issuedAt,
        expiresAt,
      });

      const reservationInput = {
        settlementId: "integration-settlement",
        quoteId: "integration-quote",
        merchantId: "integration-merchant",
        network: "stacks:2147483648",
        txid: `0x${"d".repeat(64)}`,
        payer: "ST2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B",
        rawTxHash: "e".repeat(64),
        verifierVersion: "@perkos/agent-sdk@0.2.0",
        verifierChecksum: "f".repeat(64),
        expectedSignedTokenHash: "c".repeat(64),
      };
      const concurrent = await Promise.all([
        database.reserveSettlement(reservationInput),
        database.reserveSettlement(reservationInput),
      ]);
      expect(concurrent.map((result) => result.created).sort()).toEqual([false, true]);
      expect(concurrent[0]?.settlement).toMatchObject({
        status: "validated",
        quoteId: "integration-quote",
        settlementId: "integration-settlement",
      });
      await expect(
        database.updateSettlementStatus(
          "integration-settlement",
          "validated",
          "pending",
          "broadcast_timeout",
          new Date(),
        ),
      ).resolves.toMatchObject({ status: "pending", failureReason: "broadcast_timeout" });
      await expect(
        database.findSettlementForMerchant("integration-settlement", "integration-merchant"),
      ).resolves.toMatchObject({ txid: reservationInput.txid, status: "pending" });
    } finally {
      await database.close();
    }
  });
});
