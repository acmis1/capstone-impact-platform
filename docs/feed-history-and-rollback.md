# Public Feed History, Backup and Controlled Rollback

## Guarantees

- Every history row is append-only evidence. Database triggers reject UPDATE and DELETE.
- `artifact_text` stores the exact JSON text captured after a successful canonical write and verification.
- SHA-256 is calculated over the exact UTF-8 text.
- Historical artifacts are checksum-verified and run through the existing `validatePublicFeed` contract before rollback preparation.
- Preparation is read-only and binds the plan to the current canonical-feed checksum.
- Execution rejects an expired or stale plan and verifies the exact canonical text after writing.
- Rollback creates a new `rollback` history version; it does not rewrite publication/removal history or project lifecycle state.
- Execution is loopback-only. Hosted rollback remains disabled.

## Required integration with existing controlled publication/removal

Do **not** replace the existing state machines. Add one call only after their canonical write has already been verified successful:

```ts
await recordVerifiedCanonicalFeedChange({
  operation: 'publication', // or 'removal'
  actorAdminId,
  verifiedArtifactText,     // exact bytes/text read back from canonical storage
  affectedProjectPublicId: publicId,
  sourceAttemptKind: 'publication',
  sourceAttemptId: attemptId,
});
```

The rollback `GlobalFeedOperationCoordinator` adapter MUST use the same exclusion/ownership mechanism already used by controlled publication and controlled public removal. Do not ship an independent lock: it would not prevent cross-operation races.

## Recovery rule

An execution is successful only when:

1. baseline is still equal to the preparation checksum;
2. target history checksum and feed validation pass again;
3. canonical write returns;
4. canonical read-back exactly equals the target text and SHA-256;
5. a new immutable rollback history row is recorded;
6. execution finalization is durable.

A crash after step 3 is recoverable by reading canonical storage first. If its exact checksum equals the target, finalize idempotently; otherwise do not report success and require controlled recovery.

## Lifecycle semantics

This feature restores feed content only. It must not silently change project `status`, delete audit rows, or pretend historical publication/removal did not occur. If the product later requires lifecycle reconciliation, define that as a separate domain contract and test it independently.
