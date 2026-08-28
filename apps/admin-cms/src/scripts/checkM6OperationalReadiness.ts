import {
  collectM6OperationalReadiness,
  formatInvalidM6OperationalReadinessInput,
  formatM6OperationalReadinessReport,
  M6OperationalReadinessInputError,
  parseM6OperationalReadinessCliArgs,
} from '../operations/m6OperationalReadiness';

export async function runM6OperationalReadinessCommand(
  args: string[] = process.argv.slice(2),
): Promise<0 | 1> {
  try {
    const options = parseM6OperationalReadinessCliArgs(args);
    const report = await collectM6OperationalReadiness(options);
    console.log(options.json
      ? JSON.stringify(report, null, 2)
      : formatM6OperationalReadinessReport(report));
    return report.classification === 'REPOSITORY_EVIDENCE_INCOMPLETE' ||
      report.classification === 'READ_ONLY_HOSTED_CHECK_FAILED'
      ? 1
      : 0;
  } catch (error) {
    if (error instanceof M6OperationalReadinessInputError) {
      console.log(formatInvalidM6OperationalReadinessInput());
      return 1;
    }
    console.log([
      'M6 OPERATIONAL READINESS EVIDENCE (READ-ONLY)',
      'HOSTED_MUTATIONS = NONE',
      'M6_OPERATIONAL_READINESS_CLASSIFICATION = REPOSITORY_EVIDENCE_INCOMPLETE',
    ].join('\n'));
    return 1;
  }
}

if (require.main === module) {
  runM6OperationalReadinessCommand().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
