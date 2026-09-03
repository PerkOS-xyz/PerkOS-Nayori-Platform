import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createAgentDocument, createLlmsText, createSupportedDocument } from "../src/documents.js";

describe("network-truthful capability documents", () => {
  it("describes an explicitly enabled mainnet settlement runtime without testnet claims", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
      NODE_ENV: "production",
      SERVICE_ORIGIN: "https://facilitator.nayori.ai",
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
      CONFIRM_MAINNET_SETTLEMENT: "yes",
      RECONCILIATION_ENABLED: "true",
      DELIVERY_LEDGER_ENABLED: "true",
      STACKS_NETWORK: "mainnet",
      STACKS_API_URL: "https://api.hiro.so",
    });

    const supported = createSupportedDocument(config);
    const agent = createAgentDocument(config);
    const llms = createLlmsText(config);

    expect(supported.status).toBe("mainnet-confirmation-delivery-ledger");
    expect(supported.networks).toEqual(["stacks:1"]);
    expect(supported.roadmap.activeNetwork).toBe("mainnet");
    expect(agent.network).toBe("mainnet");
    expect(agent.authorization.writes).not.toContain("testnet");
    expect(llms).toContain("settle on mainnet");
    expect(llms).not.toContain("settle on testnet");
  });
});

