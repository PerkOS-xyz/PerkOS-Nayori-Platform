# QA backup operator

Status (2026-09-10): deployed and scheduled in QA using release
`bb260b10230a29ca28995c987cfc7726b31e6dc0`. **Private uploads remain disabled.**
This command is never imported by the API and does not restore files automatically.

The QA timer runs reconciliation followed by retention every five minutes, batch size one.
Its one-shot containers mount only the source reader and the required backup role. The database
network stays internal; a separate operator egress network provides HTTPS access to S3.
Production has not been activated by this QA rollout.

## Verified QA operations

- Migrations 009/010 applied after a protected database backup.
- Metadata backups include both `private_evidence_objects` and `private_evidence_backups`.
- A real timer invocation copied a synthetic file, verified its exact bytes/hash and persisted
  a verified ledger entry with exactly one backup version.
- A two-table dump containing that fixture was restored into isolated PostgreSQL; the restored
  object and ledger hash matched. This is a table-level recovery test, not a full VPS disaster drill.
- Synthetic S3 versions and source/ledger rows were removed after verification; the temporary
  restore database and network were removed. Internal fixtures are not external adoption.
- Existing QA watchdog/Resend integration monitors operator failure, inactivity and stale runs.
  A monitor on the same VPS does not detect complete loss of that VPS independently.

End-to-end private upload/authorization integration remains a separate gate. These checks do not
claim that private uploads are enabled or that mainnet has this operational configuration.

After building, run `npm run evidence:backup:qa` with an external protected environment file.
Never paste credentials in command arguments, logs, repository files or support tickets.

## Configuration

Use the existing explicit direct-evidence QA configuration (testnet, QA OAuth origins, testnet
Hiro origin, allowed testnet contracts, QA database URL, region, account and source bucket).
The operator additionally requires `S3_BACKUP_QA_ENABLED=true`. Its private env may set
`S3_EVIDENCE_QA_ENABLED=true`; **do not enable that flag in the API** as a side effect.

| Variable | Meaning |
| --- | --- |
| `S3_BACKUP_OPERATION` | `status` (default), `reconcile`, or `retire`; no restore mode |
| `CONFIRM_QA_BACKUP_WRITES` | `no` (default) or exactly `yes`; status rejects yes |
| `S3_BACKUP_BATCH` | Integer 1–10, default 1 |
| `S3_BACKUP_BUCKET` | `perkos-nayori-qa-evidence-backup-<account-id>` |
| `S3_EVIDENCE_BUCKET` | `perkos-nayori-qa-evidence-<account-id>` |
| `S3_EVIDENCE_CREDENTIALS_FILE` | Protected source reader JSON file |
| `S3_BACKUP_WRITER_CREDENTIALS_FILE` | Separate backup writer file for reconciliation |
| `S3_BACKUP_CLEANUP_CREDENTIALS_FILE` | Separate backup cleanup file for retention |

Credential files must be canonical absolute paths, mode 0600, single-link regular files owned
by the process user or root. The loader rejects symlinks and invalid formats. There is no default
AWS credential chain. Source and backup access-key IDs must differ. Status does not load AWS keys.
Naming and network guards do not replace verification of the QA database and IAM policies.

## Permission boundaries

- Source reader: exact-version reads under the QA source prefix; no primary writes/deletes.
- Backup writer: conditional Put plus Get/GetVersion and scoped ListBucket for absence detection;
  no delete permission. Reconciliation never mounts restore keys.
- Backup cleanup: Get/GetVersion, ListBucketVersions and DeleteObjectVersion only for the QA
  backup prefix; no primary access or backup writes.
- Restore: remains a separate, explicit operator operation with its own permissions.

The adapter currently constructs a source client for retention too; that source credential must
remain read-only. IAM policies and actual mounted identities still need live verification.

## Diagnostics and exit codes

Before any operation, inspect at most 100 ledger rows in allowed contracts plus unscoped entries.
Unknown contract, inconsistent metadata or a truncated inspection produces attention and prevents
writes. No record is automatically repaired. At more than 100 matching rows this gate requires
operator work; pagination must be added and verified before scaling beyond this inspection cap.

| Exit | Meaning |
| --- | --- |
| 0 | Status/batch completed, including dry-run; not proof that all pending work is drained |
| 1 | Configuration, database, credentials or operation failure; generic log only |
| 2 | Inconsistency/quarantine/truncation or failed reconciliation items; operator attention |
| 3 | Another batch holds the advisory lock; no overlapping work started |

The scheduler must alert on nonzero exits and missed runs. Run status, dry-run, then a
single explicitly confirmed QA fixture batch before scheduling. Verify partial-write recovery,
retention and monitoring end-to-end. Never delete a ledger row to silence an alert: verify S3
absence and original binding first. No production deployment or automatic repair is authorized
by merely merging this operator.
