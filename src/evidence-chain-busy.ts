/** A fresh, internally consistent chain snapshot was not available in the bounded read window. */
export class EvidenceChainBusy extends Error {
  readonly retryAfterSeconds = 1;
  constructor() { super("private_evidence_temporarily_unavailable"); }
}
