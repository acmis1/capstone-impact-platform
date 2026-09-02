/**
 * Read-only hosted deployment readiness inspection and evaluation.
 *
 * Function discovery uses only the PostgREST OpenAPI document. It must never
 * execute an RPC because repository RPCs can mutate authoritative state.
 */

export const EXPECTED_REPOSITORY_MIGRATION_COUNT = 49;

export const EXPECTED_REPOSITORY_MIGRATIONS = [
  '20260601035138_staging_schema.sql',
  '20260601035139_staging_rls_policies.sql',
  '20260715102956_admin_auth_identity.sql',
  '20260719003407_explicit_data_api_grants.sql',
  '20260719165118_initial_admin_bootstrap.sql',
  '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
  '20260803174000_harden_function_execute_defaults.sql',
  '20260803180000_transactional_review_actions.sql',
  '20260808170000_transactional_project_metadata_update.sql',
  '20260810090000_atomic_browser_import_metadata_stage.sql',
  '20260810120000_atomic_browser_import_media_stage.sql',
  '20260810150000_atomic_import_batch_review_submit.sql',
  '20260810180000_participant_preview_links.sql',
  '20260811090000_participant_preview_confirmations.sql',
  '20260811120000_participant_preview_correction_requests.sql',
  '20260811130000_participant_preview_correction_resolution.sql',
  '20260811150000_publication_readiness_gate.sql',
  '20260811160000_approval_edit_gate.sql',
  '20260812120000_controlled_publication_execution.sql',
  '20260812150000_controlled_public_removal.sql',
  '20260813002154_project_metadata_audit_history.sql',
  '20260813120000_staff_identity_provisioning.sql',
  '20260813180000_participant_preview_email_notifications.sql',
  '20260813190000_participant_preview_reminder_schedules.sql',
  '20260814090000_accessible_full_text_gate.sql',
  '20260814140000_snapshot_image_alt_text.sql',
  '20260816144917_staging_uat_direct_account_finalization.sql',
  '20260817090000_private_media_approval_gate.sql',
  '20260819214431_password_recovery_session_provenance.sql',
  '20260820120000_assistive_validation_persistence.sql',
  '20260820160000_assistive_validation_job_coordination.sql',
  '20260821090000_assistive_validation_staff_inspection.sql',
  '20260821140000_assistive_duplicate_shortlist.sql',
  '20260824050000_multi_image_gallery.sql',
  '20260824055000_snapshot_alt_text_media_identity.sql',
  '20260824060000_multi_image_gallery_approval_gate.sql',
  '20260824070000_multi_image_gallery_participant_preview.sql',
  '20260824080000_multi_image_gallery_publication_readiness.sql',
  '20260824120000_bulk_project_review_concurrency.sql',
  '20260824180000_public_feed_deployment_ledger.sql',
  '20260824183000_public_feed_writer_protocol.sql',
  '20260825025000_multi_image_gallery_review_submission.sql',
  '20260825030000_public_feed_taxonomy_operation_guard.sql',
  '20260826090000_public_feed_activation_authority_guard.sql',
  '20260828090000_assistive_language_findings.sql',
  '20260828120000_assistive_worker_heartbeat.sql',
  '20260828170000_assistive_execution_control.sql',
  '20260831090000_postgres17_maintain_privilege_alignment.sql',
  '20260902010606_controlled_project_links_import.sql',
] as const;

export const REQUIRED_CORE_TABLES = [
  'programs',
  'disciplines',
  'industry_categories',
  'admin_users',
  'user_roles',
  'import_batches',
  'projects',
  'project_disciplines',
  'project_industry_categories',
  'media_assets',
  'validation_flags',
  'approval_records',
  'published_snapshots',
] as const;

export const REQUIRED_IMPORT_LEDGER_TABLES = [
  'browser_import_commits',
  'browser_import_media_commits',
] as const;

export const REQUIRED_PREVIEW_TABLES = [
  'participant_previews',
  'participant_preview_confirmations',
  'participant_preview_correction_requests',
] as const;

export const REQUIRED_PUBLICATION_TABLES = [
  'publication_attempts',
  'public_removal_attempts',
  'public_feed_operations',
  'public_feed_versions',
  'public_feed_version_members',
  'public_feed_head',
  'feed_rollback_preparations',
  'public_feed_operation_events',
  'public_feed_activation_authority',
  'public_feed_project_projection_authority',
  'public_feed_discipline_projection_authority',
] as const;

export const REQUIRED_STAFF_TABLES = ['staff_provisioning_requests'] as const;

export const REQUIRED_AUTH_PROVENANCE_TABLES = ['password_recovery_sessions'] as const;

export const REQUIRED_ASSISTIVE_TABLES = [
  'assistive_validation_runs',
  'assistive_validation_findings',
  'assistive_validation_jobs',
  'assistive_worker_heartbeats',
] as const;

export const REQUIRED_NOTIFICATION_TABLES = [
  'participant_preview_notifications',
  'participant_preview_reminder_schedules',
] as const;

export const ALL_REQUIRED_TABLES = [
  ...REQUIRED_CORE_TABLES,
  ...REQUIRED_IMPORT_LEDGER_TABLES,
  ...REQUIRED_PREVIEW_TABLES,
  ...REQUIRED_PUBLICATION_TABLES,
  ...REQUIRED_STAFF_TABLES,
  ...REQUIRED_AUTH_PROVENANCE_TABLES,
  ...REQUIRED_NOTIFICATION_TABLES,
  ...REQUIRED_ASSISTIVE_TABLES,
] as const;

export type RequiredRpcSignature = {
  name: string;
  parameterNames: readonly string[];
  parameterTypes: readonly string[];
};

function rpc(
  name: string,
  parameterNames: readonly string[],
  parameterTypes: readonly string[]
): RequiredRpcSignature {
  return { name, parameterNames, parameterTypes };
}

/** Final application RPC signatures granted to service_role by the repository migrations. */
export const REQUIRED_RPC_SIGNATURES = [
  rpc('bootstrap_initial_admin', ['p_auth_user_id', 'p_email', 'p_full_name'], ['uuid', 'text', 'text']),
  rpc('register_password_recovery_session', ['p_session_id', 'p_auth_user_id'], ['uuid', 'uuid']),
  rpc('perform_project_review_action', ['p_public_id', 'p_action', 'p_comments', 'p_admin_id'], ['text', 'text', 'text', 'uuid']),
  rpc('perform_project_workflow_action_if_current', ['p_public_id', 'p_action', 'p_comments', 'p_admin_id', 'p_expected_updated_at'], ['text', 'text', 'text', 'uuid', 'timestamptz']),
  rpc('get_bulk_project_review_evidence', ['p_project_ids'], ['uuid[]']),
  rpc(
    'update_project_metadata',
    ['p_public_id', 'p_title', 'p_summary', 'p_background', 'p_solution', 'p_year', 'p_program_id', 'p_discipline_ids', 'p_industry_category_ids', 'p_expected_updated_at', 'p_admin_id', 'p_poster_text', 'p_accessibility_text'],
    ['text', 'text', 'text', 'text', 'text', 'integer', 'uuid', 'uuid[]', 'uuid[]', 'timestamptz', 'uuid', 'text', 'text']
  ),
  rpc('stage_browser_import_metadata', ['p_intent_hash', 'p_preview_fingerprint', 'p_canonical_intent', 'p_mode', 'p_source_folder', 'p_imported_by_id', 'p_packages'], ['text', 'text', 'jsonb', 'text', 'text', 'uuid', 'jsonb']),
  rpc('finalize_browser_import_media_stage', ['p_batch_id', 'p_media_intent_hash', 'p_metadata_intent_hash', 'p_completed_by_id', 'p_assets'], ['uuid', 'text', 'text', 'uuid', 'jsonb']),
  rpc('submit_import_projects_for_review', ['p_batch_id', 'p_project_public_ids', 'p_admin_id', 'p_comments'], ['uuid', 'text[]', 'uuid', 'text']),
  rpc('generate_participant_preview', ['p_public_id', 'p_admin_id', 'p_token_hash', 'p_expires_in_seconds', 'p_private_bucket'], ['text', 'uuid', 'text', 'integer', 'text']),
  rpc('generate_participant_preview', ['p_public_id', 'p_admin_id', 'p_token_hash', 'p_expires_in_seconds', 'p_private_bucket', 'p_is_correction_reissue'], ['text', 'uuid', 'text', 'integer', 'text', 'boolean']),
  rpc('revoke_participant_preview', ['p_public_id', 'p_admin_id'], ['text', 'uuid']),
  rpc('resolve_participant_preview', ['p_token_hash'], ['text']),
  rpc('confirm_participant_preview', ['p_token_hash'], ['text']),
  rpc('request_participant_preview_correction', ['p_token_hash', 'p_comment'], ['text', 'text']),
  rpc('start_participant_preview_correction_resolution', ['p_public_id', 'p_admin_id'], ['text', 'uuid']),
  rpc('get_project_publication_readiness', ['p_public_id', 'p_admin_id', 'p_private_bucket'], ['text', 'uuid', 'text']),
  rpc('get_project_reconciliation_readiness', ['p_public_id', 'p_admin_id', 'p_private_bucket'], ['text', 'uuid', 'text']),
  rpc('reserve_publication_attempt', ['p_public_id', 'p_admin_id', 'p_private_bucket', 'p_confirmed_preview_id', 'p_confirmed_at'], ['text', 'uuid', 'text', 'uuid', 'timestamptz']),
  rpc('prepare_publication_attempt', ['p_attempt_id', 'p_execution_token', 'p_private_bucket', 'p_candidate_record_count', 'p_candidate_feed_hash', 'p_candidate_feed_content', 'p_feed_storage_bucket', 'p_feed_storage_path', 'p_feed_public_url', 'p_previous_feed_existed', 'p_previous_feed_content', 'p_media_manifest'], ['uuid', 'uuid', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'jsonb']),
  rpc('claim_publication_attempt', ['p_public_id', 'p_admin_id'], ['text', 'uuid']),
  rpc('mark_publication_attempt_storage_written', ['p_attempt_id', 'p_execution_token', 'p_verified_feed_hash', 'p_verified_record_count'], ['uuid', 'uuid', 'text', 'integer']),
  rpc('finalize_publication_attempt', ['p_attempt_id', 'p_execution_token', 'p_private_bucket'], ['uuid', 'uuid', 'text']),
  rpc('fail_publication_attempt', ['p_attempt_id', 'p_execution_token', 'p_failure_code', 'p_compensation_failure_code'], ['uuid', 'uuid', 'text', 'text']),
  rpc('reserve_public_removal_attempt', ['p_public_id', 'p_admin_id', 'p_archive_reason'], ['text', 'uuid', 'text']),
  rpc('prepare_public_removal_attempt', ['p_attempt_id', 'p_execution_token', 'p_candidate_record_count', 'p_candidate_feed_hash', 'p_candidate_feed_content', 'p_feed_storage_bucket', 'p_feed_storage_path', 'p_feed_public_url', 'p_previous_feed_existed', 'p_previous_feed_content'], ['uuid', 'uuid', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text']),
  rpc('claim_public_removal_attempt', ['p_public_id', 'p_admin_id'], ['text', 'uuid']),
  rpc('mark_public_removal_storage_written', ['p_attempt_id', 'p_execution_token', 'p_verified_feed_hash', 'p_verified_record_count'], ['uuid', 'uuid', 'text', 'integer']),
  rpc('finalize_public_removal_attempt', ['p_attempt_id', 'p_execution_token'], ['uuid', 'uuid']),
  rpc('fail_public_removal_attempt', ['p_attempt_id', 'p_execution_token', 'p_failure_code', 'p_compensation_failure_code'], ['uuid', 'uuid', 'text', 'text']),
  rpc('reserve_staff_provisioning', ['p_actor_admin_id', 'p_email', 'p_full_name', 'p_roles'], ['uuid', 'text', 'text', 'text[]']),
  rpc('recover_staff_provisioning_identity', ['p_request_id', 'p_execution_token'], ['uuid', 'uuid']),
  rpc('bind_staff_provisioning_identity', ['p_request_id', 'p_execution_token', 'p_auth_user_id'], ['uuid', 'uuid', 'uuid']),
  rpc('finalize_staff_provisioning', ['p_request_id', 'p_execution_token'], ['uuid', 'uuid']),
  rpc('finalize_and_activate_staff_provisioning', ['p_request_id', 'p_execution_token'], ['uuid', 'uuid']),
  rpc('begin_staff_provisioning_compensation', ['p_request_id', 'p_execution_token', 'p_auth_user_id'], ['uuid', 'uuid', 'uuid']),
  rpc('activate_staff_provisioning', ['p_auth_user_id'], ['uuid']),
  rpc('fail_staff_provisioning', ['p_request_id', 'p_execution_token', 'p_failure_code', 'p_compensation_state'], ['uuid', 'uuid', 'text', 'text']),
  rpc('reserve_participant_preview_notification', ['p_participant_preview_id', 'p_admin_id', 'p_notification_kind'], ['uuid', 'uuid', 'text']),
  rpc('generate_participant_preview_with_notification', ['p_public_id', 'p_admin_id', 'p_token_hash', 'p_expires_in_seconds', 'p_private_bucket', 'p_is_correction_reissue'], ['text', 'uuid', 'text', 'integer', 'text', 'boolean']),
  rpc('begin_participant_preview_notification_transport', ['p_notification_id', 'p_execution_token'], ['uuid', 'uuid']),
  rpc('finalize_participant_preview_notification', ['p_notification_id', 'p_execution_token', 'p_outcome', 'p_transport_reference', 'p_failure_code'], ['uuid', 'uuid', 'text', 'text', 'text']),
  rpc('reconcile_participant_preview_notification', ['p_notification_id'], ['uuid']),
  rpc('schedule_participant_preview_reminder', ['p_public_id', 'p_admin_id', 'p_scheduled_for'], ['text', 'uuid', 'timestamptz']),
  rpc('cancel_participant_preview_reminder', ['p_public_id', 'p_admin_id', 'p_reference'], ['text', 'uuid', 'uuid']),
  rpc('claim_due_participant_preview_reminders', ['p_batch_limit'], ['integer']),
  rpc('update_snapshot_image_alt_text', ['p_public_id', 'p_media_asset_id', 'p_alt_text', 'p_expected_updated_at', 'p_admin_id'], ['text', 'uuid', 'text', 'timestamptz', 'uuid']),
  rpc(
    'persist_assistive_validation_run',
    ['p_project_id', 'p_actor_admin_id', 'p_input_hash', 'p_pipeline_version', 'p_status', 'p_failure_code', 'p_findings'],
    ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'jsonb']
  ),
  rpc('record_assistive_finding_disposition', ['p_finding_id', 'p_actor_admin_id', 'p_disposition'], ['uuid', 'uuid', 'text']),
  rpc('get_latest_assistive_validation_run', ['p_project_id', 'p_pipeline_version'], ['uuid', 'text']),
  rpc('get_project_assistive_validation_inspection', ['p_project_id', 'p_pipeline_version', 'p_run_id'], ['uuid', 'text', 'uuid']),
  rpc('enqueue_assistive_validation_run', ['p_project_id', 'p_actor_admin_id', 'p_input_hash', 'p_pipeline_version'], ['uuid', 'uuid', 'text', 'text']),
  rpc('get_assistive_validation_run_status', ['p_run_id'], ['uuid']),
  rpc('get_assistive_validation_job_health', [], []),
  rpc('claim_next_assistive_validation_job', ['p_worker_id', 'p_lease_seconds'], ['uuid', 'integer']),
  rpc('heartbeat_assistive_validation_job', ['p_job_id', 'p_claim_token', 'p_lease_seconds'], ['uuid', 'uuid', 'integer']),
  rpc('advance_assistive_validation_job_stage', ['p_job_id', 'p_claim_token'], ['uuid', 'uuid']),
  rpc('request_assistive_validation_cancellation', ['p_run_id', 'p_actor_admin_id'], ['uuid', 'uuid']),
  rpc('supersede_assistive_validation_job', ['p_job_id', 'p_claim_token'], ['uuid', 'uuid']),
  rpc('record_assistive_validation_job_failure', ['p_job_id', 'p_claim_token', 'p_failure_code'], ['uuid', 'uuid', 'text']),
  rpc('finalize_assistive_validation_job', ['p_job_id', 'p_claim_token', 'p_input_hash', 'p_status', 'p_completion_code', 'p_findings'], ['uuid', 'uuid', 'text', 'text', 'text', 'jsonb']),
  rpc('upsert_assistive_worker_heartbeat', ['p_worker_instance_id', 'p_environment', 'p_pipeline_version', 'p_deployment_version', 'p_ocr_capability', 'p_language_capability', 'p_health_state'], ['text', 'text', 'text', 'text', 'text', 'text', 'text']),
  rpc('get_assistive_worker_availability', ['p_environment', 'p_pipeline_version', 'p_deployment_version', 'p_ocr_capability', 'p_language_capability', 'p_freshness_seconds'], ['text', 'text', 'text', 'text', 'text', 'integer']),
  // Migration 0047 execution control. The dispatcher-side routines live in a separate schema that
  // is never exposed through the Data API, so only these service-role routines appear here.
  rpc('register_assistive_executor', ['p_deployment_version', 'p_image_digest', 'p_configuration_version', 'p_registration_days'], ['text', 'text', 'text', 'integer']),
  rpc('claim_assistive_execution_reservation', ['p_reservation_token', 'p_generation', 'p_worker_instance_id', 'p_deployment_version', 'p_image_digest', 'p_execution_mode'], ['uuid', 'bigint', 'text', 'text', 'text', 'text']),
  rpc('settle_assistive_execution_reservation', ['p_reservation_token', 'p_generation', 'p_outcome', 'p_processed_job_count'], ['uuid', 'bigint', 'text', 'integer']),
  rpc('get_assistive_executor_availability', ['p_pipeline_version', 'p_deployment_version', 'p_image_digest', 'p_ocr_capability', 'p_language_capability'], ['text', 'text', 'text', 'text', 'text']),
  rpc('reserve_public_feed_operation', ['p_operation_key', 'p_kind', 'p_publication_mode', 'p_admin_id', 'p_public_id', 'p_owner_token', 'p_confirmed_preview_id', 'p_confirmed_at', 'p_private_bucket', 'p_archive_reason', 'p_rollback_preparation_handle', 'p_rollback_acknowledgement', 'p_storage_bucket', 'p_storage_path', 'p_rollback_capability'], ['uuid', 'text', 'text', 'uuid', 'text', 'text', 'uuid', 'timestamptz', 'text', 'text', 'uuid', 'text', 'text', 'text', 'boolean']),
  rpc('bind_public_feed_operation', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id', 'p_baseline_version_id', 'p_baseline_storage_existed', 'p_baseline_feed_hash', 'p_baseline_record_count', 'p_baseline_feed_content', 'p_candidate_feed_hash', 'p_candidate_record_count', 'p_candidate_feed_content', 'p_candidate_members', 'p_feed_public_url', 'p_media_manifest'], ['uuid', 'bigint', 'text', 'uuid', 'uuid', 'boolean', 'text', 'integer', 'text', 'text', 'integer', 'text', 'jsonb', 'text', 'jsonb']),
  rpc('renew_public_feed_operation_lease', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id'], ['uuid', 'bigint', 'text', 'uuid']),
  rpc('mark_public_feed_write_started', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id'], ['uuid', 'bigint', 'text', 'uuid']),
  rpc('mark_public_feed_candidate_observed', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id', 'p_observed_hash', 'p_observed_record_count'], ['uuid', 'bigint', 'text', 'uuid', 'text', 'integer']),
  rpc('claim_public_feed_operation', ['p_operation_id', 'p_admin_id', 'p_new_owner_token'], ['uuid', 'uuid', 'text']),
  rpc('finalize_public_feed_operation', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_completion_actor_id'], ['uuid', 'bigint', 'text', 'uuid']),
  rpc('complete_public_feed_operation', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id', 'p_observed_hash', 'p_observed_record_count'], ['uuid', 'bigint', 'text', 'uuid', 'text', 'integer']),
  rpc('fail_public_feed_operation', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id', 'p_failure_code'], ['uuid', 'bigint', 'text', 'uuid', 'text']),
  rpc('require_public_feed_recovery', ['p_operation_id', 'p_owner_epoch', 'p_owner_token', 'p_actor_id', 'p_failure_code', 'p_observed_hash', 'p_observed_record_count'], ['uuid', 'bigint', 'text', 'uuid', 'text', 'text', 'integer']),
  rpc('prepare_public_feed_rollback', ['p_admin_id', 'p_target_version_number', 'p_observed_storage_hash', 'p_observed_storage_record_count', 'p_lifecycle_drift'], ['uuid', 'bigint', 'text', 'integer', 'jsonb']),
] as const satisfies readonly RequiredRpcSignature[];

export const REQUIRED_RPC_NAMES = [...new Set(REQUIRED_RPC_SIGNATURES.map(({ name }) => name))] as readonly string[];

export const REQUIRED_STORAGE_BUCKETS = [
  'project-drafts-private',
  'project-public-assets',
  'public-feeds',
] as const;

export type EvidenceState = 'PRESENT' | 'INCOMPLETE' | 'UNVERIFIED';

export interface ManualSchemaEvidence {
  migrationHistoryMatches: boolean;
  exactSchemaObjectsMatch: boolean;
  exactConstraintsMatch: boolean;
  exactGrantsMatch: boolean;
  exactRpcSignaturesMatch: boolean;
}

export interface HostedReadinessEvidence {
  targetIdentityMatch: boolean;
  inspectionBlocked?: boolean;
  migrationHistoryReadable: boolean;
  recordedMigrationVersions: string[];
  presentTables: string[];
  unverifiedTables?: string[];
  rpcMetadataReadable: boolean;
  presentRpcNames: string[];
  presentRpcSignatures: RequiredRpcSignature[];
  relationMetadataReadable: boolean;
  publicRelations: string[];
  storageEvidenceReadable: boolean;
  presentBuckets: string[];
  authUserIdColumnPresent: boolean | null;
  initialAdminLinkagePresent: boolean | null;
  recognizedRolesPresent: boolean | null;
  manualEvidence?: ManualSchemaEvidence;
}

export type DeploymentClassification =
  | 'READY_FOR_MUTATION_DECISION'
  | 'MANUAL_EVIDENCE_REQUIRED'
  | 'RECONCILIATION_REQUIRED'
  | 'DRIFT_REQUIRES_REVIEW'
  | 'BLOCKED';

export interface HostedReadinessEvaluation {
  targetIdentityMatch: boolean;
  migrationHistoryReadable: boolean;
  repositoryMigrationsCount: number;
  hostedRecordedMigrations: number | 'UNKNOWN';
  schemaBaseline: 'MATCH' | 'DRIFT' | 'INCOMPLETE' | 'UNVERIFIED' | 'UNKNOWN';
  requiredRpcNames: EvidenceState;
  requiredRpcSignatures: EvidenceState;
  requiredTableSet: EvidenceState;
  requiredStorageBuckets: EvidenceState;
  authFoundation: 'READY' | 'INCOMPLETE' | 'UNVERIFIED';
  manualEvidenceRequired: boolean;
  deploymentClassification: DeploymentClassification;
  missingTables: string[];
  unverifiedTables: string[];
  missingRpcNames: string[];
  unverifiedRpcSignatures: string[];
  missingBuckets: string[];
  missingMigrations: string[];
  unexpectedPublicRelations: string[];
  notes: string[];
}

function signatureKey(signature: RequiredRpcSignature): string {
  return `${signature.name}(${signature.parameterNames.join(',')})`;
}

function hasExactSignature(actual: RequiredRpcSignature[], expected: RequiredRpcSignature): boolean {
  return actual.some(
    (candidate) =>
      candidate.name === expected.name &&
      candidate.parameterNames.join(',') === expected.parameterNames.join(',') &&
      candidate.parameterTypes.join(',') === expected.parameterTypes.join(',')
  );
}

function manualEvidenceComplete(evidence?: ManualSchemaEvidence): boolean {
  return Boolean(
    evidence?.migrationHistoryMatches &&
      evidence.exactSchemaObjectsMatch &&
      evidence.exactConstraintsMatch &&
      evidence.exactGrantsMatch &&
      evidence.exactRpcSignaturesMatch
  );
}

/** Pure evaluation. Automated inspection cannot provide the manual Gate 3/4 evidence. */
export function evaluateHostedDeploymentReadiness(evidence: HostedReadinessEvidence): HostedReadinessEvaluation {
  const notes: string[] = [];
  const unverifiedTables = evidence.unverifiedTables ?? [];

  if (!evidence.targetIdentityMatch || evidence.inspectionBlocked) {
    return {
      targetIdentityMatch: evidence.targetIdentityMatch,
      migrationHistoryReadable: false,
      repositoryMigrationsCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
      hostedRecordedMigrations: 'UNKNOWN',
      schemaBaseline: 'UNKNOWN',
      requiredRpcNames: 'UNVERIFIED',
      requiredRpcSignatures: 'UNVERIFIED',
      requiredTableSet: 'UNVERIFIED',
      requiredStorageBuckets: 'UNVERIFIED',
      authFoundation: 'UNVERIFIED',
      manualEvidenceRequired: true,
      deploymentClassification: 'BLOCKED',
      missingTables: [],
      unverifiedTables: [...ALL_REQUIRED_TABLES],
      missingRpcNames: [],
      unverifiedRpcSignatures: REQUIRED_RPC_SIGNATURES.map(signatureKey),
      missingBuckets: [],
      missingMigrations: [],
      unexpectedPublicRelations: [],
      notes: [
        evidence.targetIdentityMatch
          ? 'Read-only inspection could not be initialized.'
          : 'Target identity guard rejected execution.',
      ],
    };
  }

  const missingTables = ALL_REQUIRED_TABLES.filter(
    (table) => !evidence.presentTables.includes(table) && !unverifiedTables.includes(table)
  );
  const requiredTableSet: EvidenceState =
    unverifiedTables.length > 0 ? 'UNVERIFIED' : missingTables.length > 0 ? 'INCOMPLETE' : 'PRESENT';

  const missingRpcNames = evidence.rpcMetadataReadable
    ? REQUIRED_RPC_NAMES.filter((name) => !evidence.presentRpcNames.includes(name))
    : [];
  const requiredRpcNames: EvidenceState = !evidence.rpcMetadataReadable
    ? 'UNVERIFIED'
    : missingRpcNames.length > 0
      ? 'INCOMPLETE'
      : 'PRESENT';

  const unverifiedRpcSignatures = evidence.rpcMetadataReadable
    ? REQUIRED_RPC_SIGNATURES.filter((expected) => !hasExactSignature(evidence.presentRpcSignatures, expected)).map(signatureKey)
    : REQUIRED_RPC_SIGNATURES.map(signatureKey);
  const requiredRpcSignatures: EvidenceState = !evidence.rpcMetadataReadable
    ? 'UNVERIFIED'
    : missingRpcNames.length > 0
      ? 'INCOMPLETE'
      : unverifiedRpcSignatures.length > 0
        ? 'UNVERIFIED'
        : 'PRESENT';

  const missingBuckets = evidence.storageEvidenceReadable
    ? REQUIRED_STORAGE_BUCKETS.filter((bucket) => !evidence.presentBuckets.includes(bucket))
    : [];
  const requiredStorageBuckets: EvidenceState = !evidence.storageEvidenceReadable
    ? 'UNVERIFIED'
    : missingBuckets.length > 0
      ? 'INCOMPLETE'
      : 'PRESENT';

  const authValues = [
    evidence.authUserIdColumnPresent,
    evidence.initialAdminLinkagePresent,
    evidence.recognizedRolesPresent,
  ];
  const authFoundation = authValues.some((value) => value === null)
    ? 'UNVERIFIED'
    : authValues.every(Boolean) && evidence.presentTables.includes('admin_users') && evidence.presentTables.includes('user_roles')
      ? 'READY'
      : 'INCOMPLETE';

  const hostedRecordedMigrations = evidence.migrationHistoryReadable
    ? evidence.recordedMigrationVersions.length
    : 'UNKNOWN';
  const expectedVersions = EXPECTED_REPOSITORY_MIGRATIONS.map((migration) => migration.split('_')[0]);
  const missingMigrations = evidence.migrationHistoryReadable
    ? expectedVersions.filter((version) => !evidence.recordedMigrationVersions.includes(version))
    : [];

  const unexpectedPublicRelations = evidence.relationMetadataReadable
    ? evidence.publicRelations.filter((relation) => !ALL_REQUIRED_TABLES.includes(relation as (typeof ALL_REQUIRED_TABLES)[number]))
    : [];
  const hasManualEvidence = manualEvidenceComplete(evidence.manualEvidence);
  const manualEvidenceProvided = evidence.manualEvidence !== undefined;
  const manualSchemaDrift = Boolean(
    evidence.manualEvidence &&
      (!evidence.manualEvidence.exactSchemaObjectsMatch ||
        !evidence.manualEvidence.exactConstraintsMatch ||
        !evidence.manualEvidence.exactGrantsMatch ||
        !evidence.manualEvidence.exactRpcSignaturesMatch)
  );
  const manualMigrationMismatch = Boolean(
    evidence.manualEvidence && !evidence.manualEvidence.migrationHistoryMatches
  );

  let schemaBaseline: HostedReadinessEvaluation['schemaBaseline'];
  if (unexpectedPublicRelations.length > 0 || manualSchemaDrift) {
    schemaBaseline = 'DRIFT';
  } else if (requiredTableSet === 'INCOMPLETE' || requiredRpcNames === 'INCOMPLETE') {
    schemaBaseline = 'INCOMPLETE';
  } else if (
    requiredTableSet === 'PRESENT' &&
    requiredRpcSignatures === 'PRESENT' &&
    evidence.relationMetadataReadable &&
    hasManualEvidence
  ) {
    schemaBaseline = 'MATCH';
  } else {
    schemaBaseline = 'UNVERIFIED';
  }

  if (!evidence.migrationHistoryReadable) notes.push('Migration history is unavailable through the configured Data API; Gate 3 evidence is required.');
  if (!evidence.rpcMetadataReadable) notes.push('PostgREST OpenAPI RPC metadata is unavailable.');
  else if (requiredRpcSignatures === 'UNVERIFIED') notes.push('OpenAPI proves RPC names but does not prove every overloaded signature; Gate 4 evidence is required.');
  if (!evidence.relationMetadataReadable) notes.push('Unexpected public-relation detection is unavailable.');
  if (!manualEvidenceProvided) notes.push('Exact constraints, grants, schema objects, migration history, and function signatures require governed Gate 3/4 evidence.');
  if (manualSchemaDrift) notes.push('Governed Gate 4 evidence reports schema, constraint, grant, or RPC-signature drift.');
  if (manualMigrationMismatch) notes.push('Governed Gate 3 evidence reports migration-history mismatch.');

  let deploymentClassification: DeploymentClassification;
  if (schemaBaseline === 'DRIFT') {
    deploymentClassification = 'DRIFT_REQUIRES_REVIEW';
  } else if (
    requiredTableSet === 'INCOMPLETE' ||
    requiredRpcNames === 'INCOMPLETE' ||
    requiredStorageBuckets === 'INCOMPLETE' ||
    authFoundation === 'INCOMPLETE' ||
    (evidence.migrationHistoryReadable && missingMigrations.length > 0) ||
    manualMigrationMismatch
  ) {
    deploymentClassification = 'RECONCILIATION_REQUIRED';
  } else if (
    schemaBaseline === 'MATCH' &&
    requiredRpcNames === 'PRESENT' &&
    requiredRpcSignatures === 'PRESENT' &&
    requiredTableSet === 'PRESENT' &&
    requiredStorageBuckets === 'PRESENT' &&
    authFoundation === 'READY' &&
    evidence.migrationHistoryReadable &&
    missingMigrations.length === 0 &&
    hasManualEvidence
  ) {
    deploymentClassification = 'READY_FOR_MUTATION_DECISION';
  } else {
    deploymentClassification = 'MANUAL_EVIDENCE_REQUIRED';
  }

  return {
    targetIdentityMatch: true,
    migrationHistoryReadable: evidence.migrationHistoryReadable,
    repositoryMigrationsCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
    hostedRecordedMigrations,
    schemaBaseline,
    requiredRpcNames,
    requiredRpcSignatures,
    requiredTableSet,
    requiredStorageBuckets,
    authFoundation,
    manualEvidenceRequired: !manualEvidenceProvided,
    deploymentClassification,
    missingTables,
    unverifiedTables,
    missingRpcNames,
    unverifiedRpcSignatures,
    missingBuckets,
    missingMigrations,
    unexpectedPublicRelations,
    notes,
  };
}

export function formatHostedReadinessReport(result: HostedReadinessEvaluation): string {
  const lines = [
    '====================================================',
    'HOSTED STAGING DEPLOYMENT READINESS REPORT',
    '====================================================',
    `TARGET_IDENTITY_MATCH = ${result.targetIdentityMatch ? 'YES' : 'NO'}`,
    `MIGRATION_HISTORY_READABLE = ${result.migrationHistoryReadable ? 'YES' : 'NO'}`,
    `REPOSITORY_MIGRATIONS = ${result.repositoryMigrationsCount}`,
    `HOSTED_RECORDED_MIGRATIONS = ${result.hostedRecordedMigrations}`,
    `SCHEMA_BASELINE = ${result.schemaBaseline}`,
    `REQUIRED_RPC_NAMES = ${result.requiredRpcNames}`,
    `REQUIRED_RPC_SIGNATURES = ${result.requiredRpcSignatures}`,
    `REQUIRED_TABLE_SET = ${result.requiredTableSet}`,
    `REQUIRED_STORAGE_BUCKETS = ${result.requiredStorageBuckets}`,
    `AUTH_FOUNDATION = ${result.authFoundation}`,
    `MANUAL_EVIDENCE_REQUIRED = ${result.manualEvidenceRequired ? 'YES' : 'NO'}`,
    `DEPLOYMENT_CLASSIFICATION = ${result.deploymentClassification}`,
    '====================================================',
  ];
  if (result.notes.length > 0) {
    lines.push('DIAGNOSTIC SUMMARY:', ...result.notes.map((note) => `- ${note}`), '====================================================');
  }
  return lines.join('\n');
}

export interface QueryResponse<T = Record<string, unknown>[]> {
  data: T | null;
  error: unknown | null;
  count?: number | null;
}

export interface QueryBuilder<T = Record<string, unknown>[]> extends PromiseLike<QueryResponse<T>> {
  limit?(count: number): QueryBuilder<T>;
  eq?(column: string, value: unknown): QueryBuilder<T>;
  not?(column: string, operator: string, value: unknown): QueryBuilder<T>;
}

export interface TableClient {
  select(cols: string, options?: { head?: boolean; count?: 'exact' }): QueryBuilder;
}

export interface HostedReadinessClient {
  from(table: string): TableClient;
  storage?: {
    listBuckets(): Promise<{ data: Array<{ id: string; name: string }> | null; error: unknown | null }>;
  };
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** Extracts only metadata; parsing the document never calls any represented endpoint. */
export function inspectPostgrestOpenApi(document: unknown): {
  rpcNames: string[];
  rpcSignatures: RequiredRpcSignature[];
  publicRelations: string[];
} | null {
  const root = objectValue(document);
  const paths = objectValue(root?.paths);
  if (!paths) return null;

  const rpcNames: string[] = [];
  const rpcSignatures: RequiredRpcSignature[] = [];
  const publicRelations: string[] = [];

  for (const [rawPath, rawPathItem] of Object.entries(paths)) {
    if (rawPath === '/') continue;
    const rpcMatch = rawPath.match(/^\/rpc\/([^/]+)$/);
    if (!rpcMatch) {
      if (/^\/[^/]+$/.test(rawPath)) publicRelations.push(decodeURIComponent(rawPath.slice(1)));
      continue;
    }

    const name = decodeURIComponent(rpcMatch[1]);
    rpcNames.push(name);
    const pathItem = objectValue(rawPathItem);
    const post = objectValue(pathItem?.post);
    const parameters = Array.isArray(post?.parameters) ? post.parameters : [];
    const bodyParameter = parameters
      .map(objectValue)
      .find((parameter) => parameter?.in === 'body' && objectValue(parameter.schema));
    const schema = objectValue(bodyParameter?.schema);
    const properties = objectValue(schema?.properties);
    if (!properties) continue;

    const parameterNames = Object.keys(properties);
    const parameterTypes = parameterNames.map((parameterName) => {
      const property = objectValue(properties[parameterName]);
      return typeof property?.format === 'string' ? property.format : '';
    });
    if (parameterTypes.every(Boolean)) rpcSignatures.push({ name, parameterNames, parameterTypes });
  }

  return {
    rpcNames: [...new Set(rpcNames)].sort(),
    rpcSignatures,
    publicRelations: [...new Set(publicRelations)].sort(),
  };
}

/** Performs one credential-scoped GET of the PostgREST root OpenAPI document. */
export async function fetchPostgrestOpenApi(
  supabaseUrl: string,
  databaseAdminKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const endpoint = new URL('/rest/v1/', `${supabaseUrl.replace(/\/$/, '')}/`);
  const headers: Record<string, string> = {
    Accept: 'application/openapi+json',
    'Accept-Profile': 'public',
    apikey: databaseAdminKey,
  };
  if (!databaseAdminKey.startsWith('sb_')) headers.Authorization = `Bearer ${databaseAdminKey}`;
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('PostgREST OpenAPI metadata request failed.');
  return await response.json();
}

function errorIndicatesMissingRelation(error: unknown): boolean {
  const value = objectValue(error);
  const code = typeof value?.code === 'string' ? value.code : '';
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  return code === 'PGRST205' || code === '42P01' || message.includes('could not find the table');
}

async function zeroRowHeadQuery(client: HostedReadinessClient, table: string): Promise<QueryResponse> {
  let query = client.from(table).select('*', { head: true });
  if (query.limit) query = query.limit(0);
  return await query;
}

async function filteredCount(
  client: HostedReadinessClient,
  table: string,
  filter: (query: QueryBuilder) => QueryBuilder
): Promise<QueryResponse> {
  let query = client.from(table).select('id', { head: true, count: 'exact' });
  query = filter(query);
  if (query.limit) query = query.limit(1);
  return await query;
}

/**
 * Uses HEAD/GET reads only. Migration history is deliberately not queried:
 * infra/supabase/config.toml does not expose supabase_migrations through the Data API.
 */
export async function checkHostedDeploymentReadinessWithClient(
  client: HostedReadinessClient,
  options?: { targetIdentityMatch?: boolean; openApiDocument?: unknown }
): Promise<HostedReadinessEvaluation> {
  const targetIdentityMatch = options?.targetIdentityMatch ?? true;
  if (!targetIdentityMatch) {
    return evaluateHostedDeploymentReadiness({
      targetIdentityMatch: false,
      migrationHistoryReadable: false,
      recordedMigrationVersions: [],
      presentTables: [],
      rpcMetadataReadable: false,
      presentRpcNames: [],
      presentRpcSignatures: [],
      relationMetadataReadable: false,
      publicRelations: [],
      storageEvidenceReadable: false,
      presentBuckets: [],
      authUserIdColumnPresent: null,
      initialAdminLinkagePresent: null,
      recognizedRolesPresent: null,
    });
  }

  const presentTables: string[] = [];
  const unverifiedTables: string[] = [];
  for (const table of ALL_REQUIRED_TABLES) {
    try {
      const result = await zeroRowHeadQuery(client, table);
      if (!result.error) presentTables.push(table);
      else if (!errorIndicatesMissingRelation(result.error)) unverifiedTables.push(table);
    } catch {
      unverifiedTables.push(table);
    }
  }

  const openApi = inspectPostgrestOpenApi(options?.openApiDocument);

  let storageEvidenceReadable = false;
  const presentBuckets: string[] = [];
  try {
    if (client.storage?.listBuckets) {
      const result = await client.storage.listBuckets();
      if (!result.error && Array.isArray(result.data)) {
        storageEvidenceReadable = true;
        result.data.forEach((bucket) => presentBuckets.push(bucket.id || bucket.name));
      }
    }
  } catch {
    // Storage evidence remains unavailable.
  }

  let authUserIdColumnPresent: boolean | null = null;
  let initialAdminLinkagePresent: boolean | null = null;
  if (presentTables.includes('admin_users')) {
    try {
      const result = await filteredCount(client, 'admin_users', (query) => {
        if (!query.not) throw new Error('Filtered count is unsupported.');
        return query.not('auth_user_id', 'is', null);
      });
      if (!result.error) {
        authUserIdColumnPresent = true;
        initialAdminLinkagePresent = typeof result.count === 'number' ? result.count > 0 : null;
      }
    } catch {
      // Auth evidence remains unavailable.
    }
  }

  let recognizedRolesPresent: boolean | null = null;
  if (presentTables.includes('user_roles')) {
    try {
      const result = await filteredCount(client, 'user_roles', (query) => {
        if (!query.eq) throw new Error('Filtered count is unsupported.');
        return query.eq('role', 'admin');
      });
      if (!result.error) recognizedRolesPresent = typeof result.count === 'number' ? result.count > 0 : null;
    } catch {
      // Auth evidence remains unavailable.
    }
  }

  return evaluateHostedDeploymentReadiness({
    targetIdentityMatch,
    migrationHistoryReadable: false,
    recordedMigrationVersions: [],
    presentTables,
    unverifiedTables,
    rpcMetadataReadable: openApi !== null,
    presentRpcNames: openApi?.rpcNames ?? [],
    presentRpcSignatures: openApi?.rpcSignatures ?? [],
    relationMetadataReadable: openApi !== null,
    publicRelations: openApi?.publicRelations ?? [],
    storageEvidenceReadable,
    presentBuckets,
    authUserIdColumnPresent,
    initialAdminLinkagePresent,
    recognizedRolesPresent,
  });
}
