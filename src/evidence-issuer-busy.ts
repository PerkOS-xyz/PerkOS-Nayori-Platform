/** Trusted issuer backpressure, never an authorization decision or upstream error body. */
export class EvidenceIssuerBusy extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfter: string | null) {
    super("private_evidence_temporarily_unavailable");
    this.retryAfterSeconds = retryAfter !== null && /^[1-9][0-9]{0,2}$/.test(retryAfter)
      && Number(retryAfter) <= 300 ? Number(retryAfter) : 60;
  }
}
