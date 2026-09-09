/** Approved operational policy. Expiry is absolute and must survive retries/restores. */
export const EVIDENCE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const EVIDENCE_BACKUP_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const EVIDENCE_UPLOAD_SECONDS = 300;
export const EVIDENCE_DOWNLOAD_SECONDS = 60;

/** Bounded process-local admission control; complements durable SQL quotas, not distributed rate limits. */
export function createEvidenceAdmission(now: () => number = Date.now) {
  const windows = new Map<string, { until: number; requests: number }>();
  return (wallet: string, operation: "prepare" | "complete" | "download") => {
    const time = now(), key = `${wallet}:${operation}`;
    for (const [k, window] of windows) if (window.until <= time) windows.delete(k);
    let window = windows.get(key);
    if (!window) {
      if (windows.size >= 10000) return false;
      window = { until: time + 60000, requests: 0 }; windows.set(key, window);
    }
    if (window.requests >= (operation === "prepare" ? 10 : 60)) return false;
    window.requests++; return true;
  };
}
