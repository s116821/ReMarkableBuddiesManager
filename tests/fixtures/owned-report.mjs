// Synthetic values shaped against Main's immutable report_version1 contract.
export function ownedReport(status = 'partial') {
  const usage = { observed_record_files: 2, observed_record_bytes: 128, declared_media_bytes: 80,
    present_referenced_media_bytes: 40, missing_references: 1, uninspected_references: 2,
    size_mismatched_references: 3, omitted_references: 4 };
  if (status === 'complete') { usage.missing_references = 0; usage.uninspected_references = 0; usage.size_mismatched_references = 0; usage.omitted_references = 0; }
  return { report_version: 1, status, owner_actor: '11111111-1111-4111-8111-111111111111',
    current_generation: '22222222-2222-4222-8222-222222222222', observed_files: 4,
    observed_apparent_bytes: 1024, complete_apparent_bytes: status === 'complete' ? 1024 : null,
    storage: { structural: { files: 1, apparent_bytes: 128 }, 'record-metadata': { files: 2, apparent_bytes: 128 }, 'media-object': { files: 1, apparent_bytes: 768 } },
    observed_domains: { conversation: usage, source: { ...usage } }, domain_accounting_complete: status === 'complete',
    cache_inspected: status === 'complete', shared_media_files: 1, shared_media_apparent_bytes: 40,
    issues: status === 'complete' ? {} : { 'omitted-media': 4, 'missing-object': 1, 'uninspected-reference': 2, 'size-mismatch': 3, 'cache-unavailable': 1 },
    byte_basis: 'apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim',
    reference_totals_additive: false, media_content_verified: false, logical_liveness_evaluated: false,
    credentials_inspected: false, native_documents_inspected: false, lease_identity_check: 'device-inode',
    excluded_scopes: ['credentials', 'native-documents', 'legacy-cache', 'external-transient-diagnostics'] };
}
export const tablet = { connection_id: 'a'.repeat(64), boot_id: '11111111-1111-1111-1111-111111111111', model: 'reMarkable 1.0',
  firmware: '3.28.0.172', firmware_conflict: false, architecture: 'armv7l', installed_version: null, provenance: 'unknown',
  service: { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' } };
export const inspection = report => ({ contract_version: 1, status: 'observed', observation: tablet, inspection: { status: 'reported', report } });

// Exact synthetic report vectors from accepted Docs87860; not producer execution evidence.
export const feedbackReportVectors = {
  "legacy1": {
    "report_version": 1,
    "status": "complete",
    "owner_actor": "11111111-1111-4111-8111-111111111111",
    "current_generation": "22222222-2222-4222-8222-222222222222",
    "observed_files": 4,
    "observed_apparent_bytes": 2000,
    "complete_apparent_bytes": 2000,
    "storage": {
      "structural": {
        "files": 3,
        "apparent_bytes": 1872
      },
      "record-metadata": {
        "files": 1,
        "apparent_bytes": 128
      }
    },
    "observed_domains": {
      "conversation": {
        "observed_record_files": 1,
        "observed_record_bytes": 128,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "source": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "export-association": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "subject-memory": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "handwriting": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      }
    },
    "domain_accounting_complete": true,
    "cache_inspected": false,
    "shared_media_files": 0,
    "shared_media_apparent_bytes": 0,
    "issues": {},
    "byte_basis": "apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim",
    "reference_totals_additive": false,
    "media_content_verified": false,
    "logical_liveness_evaluated": false,
    "credentials_inspected": false,
    "native_documents_inspected": false,
    "lease_identity_check": "device-inode",
    "excluded_scopes": [
      "credentials",
      "native-documents",
      "legacy-cache",
      "external-transient-diagnostics"
    ]
  },
  "feedback3": {
    "report_version": 2,
    "status": "complete",
    "owner_actor": "11111111-1111-4111-8111-111111111111",
    "current_generation": "22222222-2222-4222-8222-222222222222",
    "observed_files": 4,
    "observed_apparent_bytes": 2000,
    "complete_apparent_bytes": 2000,
    "storage": {
      "structural": {
        "files": 3,
        "apparent_bytes": 1872
      },
      "record-metadata": {
        "files": 1,
        "apparent_bytes": 128
      }
    },
    "observed_domains": {
      "conversation": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "source": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "export-association": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "subject-memory": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "handwriting": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "unassociated-feedback": {
        "observed_record_files": 1,
        "observed_record_bytes": 128,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      }
    },
    "domain_accounting_complete": true,
    "cache_inspected": false,
    "shared_media_files": 0,
    "shared_media_apparent_bytes": 0,
    "issues": {},
    "byte_basis": "apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim",
    "reference_totals_additive": false,
    "media_content_verified": false,
    "logical_liveness_evaluated": false,
    "credentials_inspected": false,
    "native_documents_inspected": false,
    "lease_identity_check": "device-inode",
    "excluded_scopes": [
      "credentials",
      "native-documents",
      "legacy-cache",
      "external-transient-diagnostics"
    ],
    "current_generation_format": 3,
    "retained_generation_formats": [
      1
    ]
  },
  "invalid_feature3": {
    "report_version": 2,
    "status": "partial",
    "owner_actor": "11111111-1111-4111-8111-111111111111",
    "current_generation": "22222222-2222-4222-8222-222222222222",
    "observed_files": 4,
    "observed_apparent_bytes": 2000,
    "complete_apparent_bytes": null,
    "storage": {
      "structural": {
        "files": 3,
        "apparent_bytes": 1872
      },
      "record-metadata": {
        "files": 1,
        "apparent_bytes": 128
      }
    },
    "observed_domains": {
      "conversation": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "source": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "export-association": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "subject-memory": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "handwriting": {
        "observed_record_files": 0,
        "observed_record_bytes": 0,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      },
      "unassociated-feedback": {
        "observed_record_files": 1,
        "observed_record_bytes": 128,
        "declared_media_bytes": 0,
        "present_referenced_media_bytes": 0,
        "missing_references": 0,
        "uninspected_references": 0,
        "size_mismatched_references": 0,
        "omitted_references": 0
      }
    },
    "domain_accounting_complete": false,
    "cache_inspected": false,
    "shared_media_files": 0,
    "shared_media_apparent_bytes": 0,
    "issues": {
      "invalid-metadata": 1
    },
    "byte_basis": "apparent-file-length-per-owned-path; data-and-cache-only; no-allocated-or-reclaimable-claim",
    "reference_totals_additive": false,
    "media_content_verified": false,
    "logical_liveness_evaluated": false,
    "credentials_inspected": false,
    "native_documents_inspected": false,
    "lease_identity_check": "device-inode",
    "excluded_scopes": [
      "credentials",
      "native-documents",
      "legacy-cache",
      "external-transient-diagnostics"
    ],
    "current_generation_format": 3,
    "retained_generation_formats": [
      1
    ]
  }
};
