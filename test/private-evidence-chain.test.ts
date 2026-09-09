import { describe, expect, it, vi } from "vitest";
import { noneCV, someCV, standardPrincipalCV, tupleCV, uintCV, responseOkCV, serializeCV } from "@stacks/transactions";
import { createPrivateEvidenceChain } from "../src/private-evidence-chain.js";
const client = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const evaluator = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4", contract = `${client}.sbtc-commerce-v5`;
const info = { network_id: 2147483648, is_fully_synced: true, stacks_tip: "a".repeat(64), stacks_tip_height: 100 };
const block = () => ({ canonical: true, hash: `0x${info.stacks_tip}`, index_block_hash: `0x${"b".repeat(64)}`, height: 100, block_time: Math.floor(Date.now()/1000) });
const job = (assigned = true) => tupleCV({ client: standardPrincipalCV(client), provider: assigned ? someCV(standardPrincipalCV(provider)) : noneCV(), evaluator: standardPrincipalCV(evaluator), status: uintCV(1) });
const result = (v: ReturnType<typeof job> | ReturnType<typeof uintCV>) => ({ okay: true, result: `0x${serializeCV(responseOkCV(v)).replace(/^0x/, "")}` });
function fixture(overrides: Record<number, unknown> = {}) {
  const responses = [info, block(), result(job()), result(uintCV(1000)), info]; let index = 0;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(overrides[index] ?? responses[index++]), { headers: { "content-type": "application/json" } }));
  // Advance unconditionally when an override is used too.
  fetcher.mockImplementation(async () => { const i = index++; return new Response(JSON.stringify(overrides[i] ?? responses[i]), { headers: { "content-type": "application/json" } }); });
  return { fetcher, read: createPrivateEvidenceChain({ network: "testnet", origin: "https://api.testnet.hiro.so", allowedContracts: [contract], fetcher }) };
}
describe("bounded private-evidence chain adapter", () => {
  it("pins both reads to canonical index hash and serializes job ID, never broadcasts", async () => {
    const f = fixture(); expect(await f.read(contract, "1")).toEqual({ network: "testnet", contract, jobId: "1", client, provider, evaluator, status: 1, escrow: 1000n });
    for (const i of [2,3]) {
      const [url, options] = f.fetcher.mock.calls[i]!;
      expect(new URL(String(url)).searchParams.get("tip")).toBe(`0x${"b".repeat(64)}`);
      expect(options?.redirect).toBe("error"); expect(options?.cache).toBe("no-store");
      expect(JSON.parse(options?.body as string).arguments).toEqual([`0x${serializeCV(uintCV(1)).replace(/^0x/, "")}`]);
    }
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
  it("preserves unassigned provider without inventing a role", async () => {
    expect((await fixture({ 2: result(job(false)) }).read(contract,"1"))?.provider).toBeNull();
  });
  it.each([
    { 0: { ...info, network_id: 1 } }, { 0: { ...info, is_fully_synced: false } },
    { 1: { ...block(), canonical: false } }, { 1: { ...block(), hash: `0x${"c".repeat(64)}` } },
    { 1: { ...block(), block_time: 1 } }, { 1: { ...block(), index_block_hash: "bad" } },
    { 2: { okay: false, cause: "private error" } }, { 2: { okay: true, result: "0x00" } },
    { 3: result(job()) }, { 4: { ...info, stacks_tip: "c".repeat(64) } },
  ])("denies wrong network, stale/moving tip, malformed or failed reads %#", async override => {
    await expect(fixture(override).read(contract,"1")).rejects.toThrow("private_evidence_access_denied");
  });
  it.each(["0", "-1", "01", "../1", (2n**128n).toString()])("rejects invalid job %s before fetch", async id => {
    const f=fixture(); await expect(f.read(contract,id)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects non-allowlisted contract before fetch", async () => {
    const f=fixture(); await expect(f.read(`${client}.other`,"1")).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["http://api.testnet.hiro.so", "https://user:secret@api.testnet.hiro.so", "https://api.testnet.hiro.so/path"])('rejects unsafe operator origin %s', origin => {
    expect(() => createPrivateEvidenceChain({ network: "testnet", origin, allowedContracts: [contract] })).toThrow();
  });
  it("bounds a non-responsive fetch even when it ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const read=createPrivateEvidenceChain({ network:"testnet",origin:"https://api.testnet.hiro.so",allowedContracts:[contract],fetcher:()=>new Promise(()=>{}) });
      const pending=expect(read(contract,"1")).rejects.toThrow("private_evidence_access_denied");
      await vi.advanceTimersByTimeAsync(5001); await pending;
    } finally { vi.useRealTimers(); }
  });
});
