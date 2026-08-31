import { Client } from 'pg';

import { runAssistiveDispatch } from '../assistive-validation/services/assistiveDispatcher';
import { getAssistiveDispatcherConfig } from '../assistive-validation/services/assistiveDispatcherConfig';
import { AzureContainerAppsJobLauncher } from '../assistive-validation/services/executorLauncher';
import { PostgresAssistiveDispatchRepository } from '../assistive-validation/repositories/assistiveDispatchRepository';

/**
 * Scheduled dispatcher entry point.
 *
 * One bounded execution: probe, prepare, reserve, mark requested, start, record, exit. It performs
 * no OCR, no language checking, no project mutation and no publication, and it exposes no inbound
 * interface. Reservation tokens are never printed in full.
 */

const config = getAssistiveDispatcherConfig();

async function main(): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: true },
    application_name: 'capstone-assistive-dispatcher',
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  const gateway = new PostgresAssistiveDispatchRepository(client);
  try {
    const report = await runAssistiveDispatch({
      gateway,
      launcher: new AzureContainerAppsJobLauncher({
        ...config.launcher,
        expectedDeploymentVersion: config.deploymentVersion,
        expectedImageDigest: config.imageDigest,
      }),
      dispatcherInstanceId: config.dispatcherInstanceId,
      deploymentVersion: config.deploymentVersion,
      imageDigest: config.imageDigest,
    });
    console.log(JSON.stringify({ schemaVersion: 'assistive-dispatch-report/v1', ...report }));
  } finally {
    await gateway.close();
  }
}

void main().catch(() => {
  console.error('[Assistive dispatcher] bounded dispatch failure');
  process.exitCode = 1;
});
