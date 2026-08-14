import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { runLocalScalingVerification } from '../benchmarks/localScalingRunner';
import {
  SYNTHETIC_PROJECT_COUNTS,
  SyntheticProjectCount,
  formatReportTable,
} from '../benchmarks/scalingBenchmarkTypes';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface CliBenchmarkOptions {
  counts: SyntheticProjectCount[];
  seed: number;
  warmupIterations: number;
  measuredIterations: number;
}

function parseIntegerFlag(
  args: string[],
  index: number,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  const rawValue = args[index + 1];
  if (rawValue === undefined || rawValue.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`Invalid ${flag} [${rawValue}]. Expected a whole decimal integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${flag} [${rawValue}]. Expected an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function parseCliArgs(args: string[]): CliBenchmarkOptions {
  let counts: SyntheticProjectCount[] = [100];
  let seed = 0xD4072026;
  let warmupIterations = 2;
  let measuredIterations = 5;
  const seen = new Set<string>();
  let countMode: '--count' | '--all' | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      if (countMode || seen.has(arg)) {
        throw new Error('Specify exactly one of --count or --all.');
      }
      countMode = '--all';
      seen.add(arg);
      counts = [...SYNTHETIC_PROJECT_COUNTS];
    } else if (arg === '--count') {
      if (countMode || seen.has(arg)) {
        throw new Error('Specify exactly one of --count or --all.');
      }
      countMode = '--count';
      seen.add(arg);
      const parsedCount = parseIntegerFlag(args, i, arg, 0, 1000) as SyntheticProjectCount;
      if (!SYNTHETIC_PROJECT_COUNTS.includes(parsedCount)) {
        throw new Error(`Invalid --count [${parsedCount}]. Supported values: ${SYNTHETIC_PROJECT_COUNTS.join(', ')}.`);
      }
      counts = [parsedCount];
      i++;
    } else if (arg === '--seed' || arg === '--warmup' || arg === '--iterations') {
      if (seen.has(arg)) throw new Error(`Duplicate option ${arg}.`);
      seen.add(arg);
      if (arg === '--seed') seed = parseIntegerFlag(args, i, arg, 0, 0xFFFFFFFF);
      if (arg === '--warmup') warmupIterations = parseIntegerFlag(args, i, arg, 0, 1000);
      if (arg === '--iterations') measuredIterations = parseIntegerFlag(args, i, arg, 1, 1000);
      i++;
    } else {
      throw new Error(`Unknown benchmark option [${arg}].`);
    }
  }

  return {
    counts,
    seed,
    warmupIterations,
    measuredIterations,
  };
}

function resolveLocalSupabaseEnv(): { apiUrl: string; serviceRoleKey: string } {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (isLoopbackUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
      return {
        apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      };
    }
  }

  try {
    const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
    const output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const parsed = parseSupabaseCliEnv(output);
    if (parsed.API_URL && parsed.SERVICE_ROLE_KEY && isLoopbackUrl(parsed.API_URL)) {
      return {
        apiUrl: parsed.API_URL,
        serviceRoleKey: parsed.SERVICE_ROLE_KEY,
      };
    }
  } catch {
    // Fall back
  }

  throw new Error(
    'Local Scaling Benchmark requires an active, loopback-only local Supabase stack.'
  );
}

export async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const { apiUrl, serviceRoleKey } = resolveLocalSupabaseEnv();

  console.log('\n================================================================================');
  console.log(' STARTING LOCAL SUPABASE SCALING & STORAGE BANDWIDTH BENCHMARK');
  console.log('================================================================================');
  console.log(` Target Endpoint:   ${apiUrl} (Verified loopback)`);
  console.log(` Target Datasets:   ${cliOptions.counts.join(', ')} projects`);
  console.log(` Measured Runs:     ${cliOptions.measuredIterations} iterations per op (${cliOptions.warmupIterations} warmups)\n`);

  for (const count of cliOptions.counts) {
    console.log(`\n>>> Executing benchmark for dataset size: ${count} projects...`);
    const { report, success, errors } = await runLocalScalingVerification({
      apiUrl,
      serviceRoleKey,
      datasetSize: count,
      seed: cliOptions.seed,
      warmupIterations: cliOptions.warmupIterations,
      measuredIterations: cliOptions.measuredIterations,
    });

    console.log('\n' + formatReportTable(report) + '\n');

    if (!success || errors.length > 0) {
      console.error(`❌ Benchmark failed for ${count} projects:`, errors);
      process.exit(1);
    }
  }

  console.log('✅ All benchmark dataset runs completed successfully.\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal benchmark error:', err);
    process.exit(1);
  });
}
