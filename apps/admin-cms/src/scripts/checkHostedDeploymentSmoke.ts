import {
  formatHostedSmokeReport,
  formatInvalidHostedSmokeInput,
  HostedSmokeInputError,
  parseHostedSmokeCliArgs,
  runHostedSmokeVerifier,
} from '../deployment/hostedDeploymentSmokeVerifier';

export async function runHostedDeploymentSmokeCommand(
  args: string[] = process.argv.slice(2),
): Promise<0 | 1> {
  try {
    const options = parseHostedSmokeCliArgs(args);
    const report = await runHostedSmokeVerifier(options);
    console.log(formatHostedSmokeReport(report));
    return report.classification === 'READY_FOR_SUPERVISED_UAT' ? 0 : 1;
  } catch (error) {
    if (error instanceof HostedSmokeInputError) {
      console.log(formatInvalidHostedSmokeInput());
      return 1;
    }
    console.log([
      'HOSTED DEPLOYMENT / UAT SMOKE (READ-ONLY)',
      'BASE_HOST = UNAVAILABLE',
      'HOSTED_MUTATIONS = NONE',
      'HOSTED_SMOKE_CLASSIFICATION = NETWORK_FAILED',
    ].join('\n'));
    return 1;
  }
}

if (require.main === module) {
  runHostedDeploymentSmokeCommand().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
