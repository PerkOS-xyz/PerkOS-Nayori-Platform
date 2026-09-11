import { ClarityType, cvToString, deserializeCV, serializeCV, uintCV, validateStacksAddress,
  type ClarityValue } from "@stacks/transactions";
import { PrivateEvidenceDenied, type PrivateEvidenceJob } from "./private-evidence-security.js";

const denied = () => new PrivateEvidenceDenied();
class SnapshotMoved extends Error {}
const hex = /^(?:0x)?[0-9a-f]{64}$/;
const uint = (v: ClarityValue | undefined): bigint => {
  if (v?.type !== ClarityType.UInt) throw denied();
  return BigInt(v.value);
};
const principal = (v: ClarityValue | undefined, network: "testnet" | "mainnet"): string => {
  if (v?.type !== ClarityType.PrincipalStandard) throw denied();
  const address = cvToString(v);
  if (!validateStacksAddress(address) || !(network === "testnet" ? /^(ST|SN)/ : /^(SP|SM)/).test(address)) throw denied();
  return address;
};

/** Trusted HTTPS node, fixed contracts, confirmed single-tip reads, no credentials or broadcasts. */
export function createPrivateEvidenceChain(options: {
  network: "testnet" | "mainnet"; origin: string; allowedContracts: readonly string[]; fetcher?: typeof fetch;
}) {
  const origin = new URL(options.origin), network = options.network;
  if (!['testnet', 'mainnet'].includes(network) || origin.protocol !== "https:" || origin.username || origin.password ||
      origin.search || origin.hash || origin.pathname !== "/" || options.allowedContracts.length === 0) throw denied();
  const contracts = new Set(options.allowedContracts);
  for (const contract of contracts) {
    const [address, name, extra] = contract.split(".");
    if (extra || !address || !name || !validateStacksAddress(address) ||
        !(network === "testnet" ? /^(ST|SN)/ : /^(SP|SM)/).test(address) || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) throw denied();
  }
  const fetcher = options.fetcher ?? fetch;
  return async (contract: string, jobId: string): Promise<PrivateEvidenceJob | null> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      if (!contracts.has(contract) || !/^[1-9][0-9]{0,38}$/.test(jobId) || BigInt(jobId) >= 2n ** 128n) throw denied();
      const request = async (path: string, body?: object): Promise<Record<string, unknown>> => {
        const response = await fetcher(new URL(path, origin), { method: body ? "POST" : "GET",
          signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit",
          headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (controller.signal.aborted || response.status !== 200 || response.redirected ||
            response.headers.get("content-type")?.split(";")[0] !== "application/json") {
          void response.body?.cancel().catch(() => undefined); throw denied();
        }
        const reader = response.body?.getReader(); if (!reader) throw denied();
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.length;
            if (length > 32768 || controller.signal.aborted) throw denied();
            chunks.push(chunk.value);
          }
        } finally { void reader.cancel().catch(() => undefined); }
        const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== "object" || Array.isArray(value) || controller.signal.aborted) throw denied();
        return value as Record<string, unknown>;
      };
      const info = await request("/v2/info");
      if (info.network_id !== (network === "testnet" ? 2147483648 : 1) || info.is_fully_synced !== true ||
          typeof info.stacks_tip !== "string" || !hex.test(info.stacks_tip) ||
          !Number.isSafeInteger(info.stacks_tip_height) || Number(info.stacks_tip_height) < 1) throw denied();
      const tip = info.stacks_tip;
      const block = await request(`/extended/v2/blocks/${info.stacks_tip_height}`);
      if (block.canonical !== true || block.hash !== `0x${tip.replace(/^0x/, "")}` || block.height !== info.stacks_tip_height ||
          typeof block.index_block_hash !== "string" || !/^0x[0-9a-f]{64}$/.test(block.index_block_hash) ||
          typeof block.block_time !== "number" || block.block_time > Date.now()/1000+30 || Date.now()/1000-block.block_time > 300) throw denied();
      const [address, name] = contract.split(".");
      const call = async (functionName: string) => {
        const result = await request(`/v2/contracts/call-read/${address}/${name}/${functionName}?tip=${encodeURIComponent(block.index_block_hash as string)}`,
          { sender: address, arguments: [`0x${serializeCV(uintCV(jobId)).replace(/^0x/, "")}`] });
        if (result.okay !== true || typeof result.result !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(result.result)) throw denied();
        const value = deserializeCV(result.result);
        if (serializeCV(value).replace(/^0x/, "") !== result.result.slice(2)) throw denied();
        if (value.type !== ClarityType.ResponseOk) throw denied();
        return value.value;
      };
      const job = await call("get-job"), escrow = await call("get-escrow-balance");
      if (job.type !== ClarityType.Tuple) throw denied();
      const status = uint(job.value.status);
      if (status > 8n) throw denied();
      const provider = job.value.provider;
      if (!provider || ![ClarityType.OptionalNone, ClarityType.OptionalSome].includes(provider.type)) throw denied();
      const assigned = provider.type === ClarityType.OptionalSome ? principal(provider.value, network) : null;
      const current = await request("/v2/info");
      if (current.network_id !== info.network_id || current.is_fully_synced !== true || controller.signal.aborted ||
          typeof current.stacks_tip !== "string" || !hex.test(current.stacks_tip) ||
          !Number.isSafeInteger(current.stacks_tip_height) || Number(current.stacks_tip_height) < 1) throw denied();
      // Discard the entire snapshot; never authorize using an earlier attempt's data.
      if (current.stacks_tip !== tip) throw new SnapshotMoved();
      return { network, contract, jobId, client: principal(job.value.client, network), provider: assigned,
        evaluator: principal(job.value.evaluator, network), status: Number(status), escrow: uint(escrow) };
    };
    try {
      const boundedRead = async () => {
        try { return await work(); }
        catch (error) {
          if (!(error instanceof SnapshotMoved) || controller.signal.aborted) throw error;
          return await work(); // One fresh snapshot, sharing the original five-second budget.
        }
      };
      return await Promise.race([boundedRead(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(denied()); }, 5000);
      })]);
    } catch { throw denied(); } finally { clearTimeout(timer); controller.abort(); }
  };
}
