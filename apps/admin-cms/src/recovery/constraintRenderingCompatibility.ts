import {
  canonicalizeSqlExpression,
  parseGate4Evidence,
  type Gate4ComparisonResult,
} from '../deployment/gate4SchemaEvidence';

/**
 * Collected from fresh repository PG17 migrations and ordinary dump replay on a bare PG17 target.
 * Migration BETWEEN expressions render as a nested AND; reparsing that rendered SQL flattens the
 * AND list. Only association changes: operands, casts, bounds, regexes, NULL handling and role
 * values are identical. These fixed, directional pairs are compared, never executed as SQL.
 */
export const REVIEWED_CONSTRAINT_RENDERING_PAIRS = [
  {
    key: 'public.participant_preview_notifications.check_participant_preview_notification_transport_reference',
    sourceDefinition: "CHECK (((transport_reference IS NULL) OR (((length(transport_reference) >= 1) AND (length(transport_reference) <= 200)) AND (transport_reference ~ '^[!-~]+$'::text))))",
    restoredDefinition: "CHECK (((transport_reference IS NULL) OR ((length(transport_reference) >= 1) AND (length(transport_reference) <= 200) AND (transport_reference ~ '^[!-~]+$'::text))))",
  },
  {
    key: 'public.public_feed_operations.public_feed_operations_public_id_check',
    sourceDefinition: "CHECK (((public_id IS NULL) OR (((length(public_id) >= 1) AND (length(public_id) <= 100)) AND (public_id ~ '^[A-Za-z0-9_-]+$'::text))))",
    restoredDefinition: "CHECK (((public_id IS NULL) OR ((length(public_id) >= 1) AND (length(public_id) <= 100) AND (public_id ~ '^[A-Za-z0-9_-]+$'::text))))",
  },
  {
    key: 'public.public_feed_version_members.public_feed_version_members_public_id_check',
    sourceDefinition: "CHECK ((((length(public_id) >= 1) AND (length(public_id) <= 100)) AND (public_id ~ '^[A-Za-z0-9_-]+$'::text)))",
    restoredDefinition: "CHECK (((length(public_id) >= 1) AND (length(public_id) <= 100) AND (public_id ~ '^[A-Za-z0-9_-]+$'::text)))",
  },
  {
    key: 'public.public_feed_versions.public_feed_versions_affected_public_id_check',
    sourceDefinition: "CHECK (((affected_public_id IS NULL) OR (((length(affected_public_id) >= 1) AND (length(affected_public_id) <= 100)) AND (affected_public_id ~ '^[A-Za-z0-9_-]+$'::text))))",
    restoredDefinition: "CHECK (((affected_public_id IS NULL) OR ((length(affected_public_id) >= 1) AND (length(affected_public_id) <= 100) AND (affected_public_id ~ '^[A-Za-z0-9_-]+$'::text))))",
  },
  {
    key: 'public.staff_provisioning_requests.check_staff_provisioning_roles',
    sourceDefinition: "CHECK ((((cardinality(requested_roles) >= 1) AND (cardinality(requested_roles) <= 3)) AND (array_position(requested_roles, NULL::text) IS NULL) AND (requested_roles <@ ARRAY['admin'::text, 'reviewer'::text, 'editor'::text])))",
    restoredDefinition: "CHECK (((cardinality(requested_roles) >= 1) AND (cardinality(requested_roles) <= 3) AND (array_position(requested_roles, NULL::text) IS NULL) AND (requested_roles <@ ARRAY['admin'::text, 'reviewer'::text, 'editor'::text])))",
  },
] as const;

/** Recovery overlay only. The ordinary Gate 4 comparator remains exact, including table grants. */
export function constraintRenderingDifferencesAreExpected(input: {
  comparison: Gate4ComparisonResult;
  sourceEvidence: unknown;
  restoredEvidence: unknown;
}): boolean {
  const { comparison } = input;
  if (comparison.classification !== 'GATE4_DRIFT' || comparison.validationErrors.length > 0
    || comparison.totalDifferences === 0 || comparison.totalDifferences > REVIEWED_CONSTRAINT_RENDERING_PAIRS.length
    || comparison.totalDifferences !== comparison.differences.length
    || Object.entries(comparison.categoryMatches).some(([category, matches]) => !matches && category !== 'CONSTRAINTS')) {
    return false;
  }
  const source = parseGate4Evidence(input.sourceEvidence);
  const restored = parseGate4Evidence(input.restoredEvidence);
  if (!source.ok || !restored.ok) return false;
  const constraints = (evidence: typeof source.evidence) => new Map(evidence.constraints
    .map((constraint) => [`${constraint.schema}.${constraint.table}.${constraint.name}`, constraint]));
  const sourceConstraints = constraints(source.evidence);
  const restoredConstraints = constraints(restored.evidence);
  // Missing known constraints cannot become portable, including omissions on both sides.
  for (const pair of REVIEWED_CONSTRAINT_RENDERING_PAIRS) {
    for (const constraint of [sourceConstraints.get(pair.key), restoredConstraints.get(pair.key)]) {
      if (!constraint || constraint.type !== 'check' || !constraint.validated
        || constraint.deferrable || constraint.initiallyDeferred) return false;
    }
  }
  return comparison.differences.every((difference) => {
    if (difference.category !== 'CONSTRAINTS' || difference.kind !== 'CHANGED'
      || difference.changedFields?.length !== 1 || difference.changedFields[0] !== 'definition') return false;
    const pair = REVIEWED_CONSTRAINT_RENDERING_PAIRS.find((candidate) => candidate.key === difference.key);
    if (!pair) return false;
    return canonicalizeSqlExpression(sourceConstraints.get(pair.key)!.definition)
        === canonicalizeSqlExpression(pair.sourceDefinition)
      && canonicalizeSqlExpression(restoredConstraints.get(pair.key)!.definition)
        === canonicalizeSqlExpression(pair.restoredDefinition);
  });
}
