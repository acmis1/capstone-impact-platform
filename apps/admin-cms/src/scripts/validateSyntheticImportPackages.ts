import {
  formatSyntheticImportValidationReport,
  runSyntheticImportValidationHarness,
} from '../fixtures/syntheticImportPackageHarness';
import {
  SYNTHETIC_IMPORT_PACKAGE_COUNTS,
  type SyntheticImportPackageCount,
} from '../fixtures/syntheticImportPackages';
import { DEFAULT_SYNTHETIC_SEED } from '../fixtures/syntheticProjects';

function parseIntegerArgument(args: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  if (!argument) return undefined;

  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative safe integer.`);
  }
  return value;
}

function parseSizes(args: string[]): SyntheticImportPackageCount[] {
  const size = parseIntegerArgument(args, 'size');
  if (size === undefined) return [...SYNTHETIC_IMPORT_PACKAGE_COUNTS];
  if (!SYNTHETIC_IMPORT_PACKAGE_COUNTS.includes(size as SyntheticImportPackageCount)) {
    throw new Error(`--size must be one of: ${SYNTHETIC_IMPORT_PACKAGE_COUNTS.join(', ')}.`);
  }
  return [size as SyntheticImportPackageCount];
}

export async function runSyntheticImportValidationCommand(
  args: string[] = process.argv.slice(2),
): Promise<string> {
  const sizes = parseSizes(args);
  const seed = parseIntegerArgument(args, 'seed') ?? DEFAULT_SYNTHETIC_SEED;
  const reports = [];

  for (const size of sizes) {
    reports.push(
      formatSyntheticImportValidationReport(
        await runSyntheticImportValidationHarness({ count: size, seed }),
      ),
    );
  }

  return reports.join('\n\n');
}

if (require.main === module) {
  runSyntheticImportValidationCommand()
    .then((output) => console.log(output))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
