import { describe, expect, it, vi } from "vitest";
import { noneCV, someCV, standardPrincipalCV, tupleCV, uintCV, responseOkCV, serializeCV } from "@stacks/transactions";
import { createPrivateEvidenceChain } from "../src/private-evidence-chain.js";
import type { EvidenceChainBusy } from "../src/evidence-chain-busy.js";
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
  function movingFixture(secondMoves = false, stall = false) {
    const next = { ...info, stacks_tip: "c".repeat(64), stacks_tip_height: 101 };
    const nextBlock = { ...block(), hash: `0x${next.stacks_tip}`, index_block_hash: `0x${"d".repeat(64)}`, height: 101 };
    const responses = [info, block(), result(job()), result(uintCV(1000)), next,
      next, nextBlock, result(job(false)), result(uintCV(0)), secondMoves ? { ...next, stacks_tip: "e".repeat(64) } : next];
    let index = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (stall && index === 0) await new Promise(resolve => setTimeout(resolve, 4900));
      if (stall && index === 5) return await new Promise<Response>(() => {});
      return new Response(JSON.stringify(responses[index++]), { headers: { "content-type": "application/json" } });
    });
    return { fetcher, read: createPrivateEvidenceChain({ network: "testnet", origin: "https://api.testnet.hiro.so", allowedContracts: [contract], fetcher }) };
  }
  it("discards moved snapshot and returns only freshly pinned job and escrow", async () => {
    const f = movingFixture();
    expect(await f.read(contract, "1")).toMatchObject({ provider: null, escrow: 0n });
    expect(f.fetcher).toHaveBeenCalledTimes(10);
    for (const index of [7, 8]) expect(new URL(String(f.fetcher.mock.calls[index]![0])).searchParams.get("tip")).toBe(`0x${"d".repeat(64)}`);
  });
  it("fails closed after a second tip movement without a third attempt", async () => {
    const f = movingFixture(true);
    await expect(f.read(contract, "1")).rejects.toMatchObject({
      name: "Error", message: "private_evidence_temporarily_unavailable", retryAfterSeconds: 1,
    } satisfies Partial<EvidenceChainBusy>);
    expect(f.fetcher).toHaveBeenCalledTimes(10);
  });
  it.each([{ ...info, stacks_tip: "bad" }, { ...info, network_id: 1 }, { ...info, is_fully_synced: false }, { ...info, stacks_tip_height: 0 }])("does not retry invalid final node metadata %#", async final => {
    const f = fixture({ 4: final });
    await expect(f.read(contract, "1")).rejects.toThrow("private_evidence_access_denied");
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
  it("shares the five-second deadline across both attempts", async () => {
    vi.useFakeTimers();
    try {
      const f = movingFixture(false, true);
      const pending = expect(f.read(contract, "1")).rejects.toThrow("private_evidence_access_denied");
      await vi.advanceTimersByTimeAsync(5001); await pending;
      expect(f.fetcher).toHaveBeenCalledTimes(6);
      expect(f.fetcher.mock.calls[5]![1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
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
