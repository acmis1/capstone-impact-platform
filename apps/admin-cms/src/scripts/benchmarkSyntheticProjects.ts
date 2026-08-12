import {
  DEFAULT_SYNTHETIC_SEED,
  generateSyntheticProjects,
  SYNTHETIC_PROJECT_COUNTS,
  SyntheticProjectCount,
} from '../fixtures/syntheticProjects';
import {
  formatSyntheticBenchmarkReport,
  runSyntheticProjectBenchmark,
} from '../benchmarks/syntheticProjectBenchmark';

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

function parseSizes(args: string[]): SyntheticProjectCount[] {
  const size = parseIntegerArgument(args, 'size');
  if (size === undefined) return [...SYNTHETIC_PROJECT_COUNTS];
  if (!SYNTHETIC_PROJECT_COUNTS.includes(size as SyntheticProjectCount)) {
    throw new Error(`--size must be one of: ${SYNTHETIC_PROJECT_COUNTS.join(', ')}.`);
  }
  return [size as SyntheticProjectCount];
}

export function runSyntheticProjectBenchmarkCommand(args: string[] = process.argv.slice(2)): string {
  const sizes = parseSizes(args);
  const seed = parseIntegerArgument(args, 'seed') ?? DEFAULT_SYNTHETIC_SEED;

  return sizes
    .map((size) => {
      const projects = generateSyntheticProjects({ count: size, seed });
      return formatSyntheticBenchmarkReport(runSyntheticProjectBenchmark(projects, { seed }));
    })
    .join('\n\n');
}

if (require.main === module) {
  try {
    console.log(runSyntheticProjectBenchmarkCommand());
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
