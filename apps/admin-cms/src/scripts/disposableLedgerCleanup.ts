export interface DisposableLedgerCleanupResidue {
  containers: string[];
  volumes: string[];
  networkPresent: boolean;
  workdirPresent: boolean;
}

export interface DisposableLedgerCleanupReport {
  clean: boolean;
  errors: string[];
  residue: DisposableLedgerCleanupResidue;
}

export interface DisposableLedgerCleanupDependencies {
  projectId: string;
  networkName: string;
  startAttempted: boolean;
  networkCreateAttempted: boolean;
  docker(args: string[]): string;
  stopSupabase(): void;
  removeWorkdir(): void;
  workdirExists(): boolean;
}

const PROJECT_ID = /^capstone-pp1-ledger-[0-9a-f]{8}$/;

function lines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function errorMessage(label: string, error: unknown): string {
  return `${label}: ${error instanceof Error ? error.message : 'unknown failure'}`;
}

/**
 * Cleans only the Docker objects carrying this verifier's unique project label and exact network
 * name. Every step is independent so one failed cleanup action cannot suppress later attempts or
 * the final residue inspection.
 */
export function cleanupDisposableLedgerRuntime(
  dependencies: DisposableLedgerCleanupDependencies,
): DisposableLedgerCleanupReport {
  const errors: string[] = [];
  const expectedNetwork = `${dependencies.projectId}-loopback`;
  if (!PROJECT_ID.test(dependencies.projectId) || dependencies.networkName !== expectedNetwork) {
    try { dependencies.removeWorkdir(); }
    catch (error) { errors.push(errorMessage('temporary workdir removal failed', error)); }
    let workdirPresent = true;
    try { workdirPresent = dependencies.workdirExists(); }
    catch (error) { errors.push(errorMessage('temporary workdir residue inspection failed', error)); }
    return {
      clean: false,
      errors: ['cleanup identity validation failed', ...errors],
      residue: {
        containers: [], volumes: [], networkPresent: false,
        workdirPresent,
      },
    };
  }

  const listContainers = () => lines(dependencies.docker([
    'ps', '-aq', '--filter', `label=com.supabase.cli.project=${dependencies.projectId}`,
  ]));
  const listVolumes = () => lines(dependencies.docker([
    'volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${dependencies.projectId}`,
  ]));
  const networkExists = () => lines(dependencies.docker([
    'network', 'ls', '--filter', `name=${dependencies.networkName}`, '--format', '{{.Name}}',
  ])).includes(dependencies.networkName);

  if (dependencies.startAttempted) {
    try { dependencies.stopSupabase(); }
    catch (error) { errors.push(errorMessage('Supabase stop failed', error)); }
  }

  try {
    const containers = listContainers();
    if (containers.length > 0) dependencies.docker(['rm', '-f', ...containers]);
  } catch (error) {
    errors.push(errorMessage('verifier container cleanup failed', error));
  }

  try {
    const volumes = listVolumes();
    if (volumes.length > 0) dependencies.docker(['volume', 'rm', ...volumes]);
  } catch (error) {
    errors.push(errorMessage('verifier volume cleanup failed', error));
  }

  if (dependencies.networkCreateAttempted) {
    try {
      if (networkExists()) dependencies.docker(['network', 'rm', dependencies.networkName]);
    } catch (error) {
      errors.push(errorMessage('verifier network cleanup failed', error));
    }
  }

  let containers: string[] = [];
  let volumes: string[] = [];
  let networkPresent = false;
  try { containers = listContainers(); }
  catch (error) { errors.push(errorMessage('verifier container residue inspection failed', error)); }
  try { volumes = listVolumes(); }
  catch (error) { errors.push(errorMessage('verifier volume residue inspection failed', error)); }
  try { networkPresent = networkExists(); }
  catch (error) { errors.push(errorMessage('verifier network residue inspection failed', error)); }

  try { dependencies.removeWorkdir(); }
  catch (error) { errors.push(errorMessage('temporary workdir removal failed', error)); }
  let workdirPresent = true;
  try { workdirPresent = dependencies.workdirExists(); }
  catch (error) { errors.push(errorMessage('temporary workdir residue inspection failed', error)); }

  const residue = { containers, volumes, networkPresent, workdirPresent };
  const hasResidue = containers.length > 0 || volumes.length > 0 || networkPresent || workdirPresent;
  return { clean: errors.length === 0 && !hasResidue, errors, residue };
}
