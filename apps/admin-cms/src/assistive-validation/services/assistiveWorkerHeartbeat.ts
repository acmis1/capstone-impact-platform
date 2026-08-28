import {
  assistiveWorkerAvailabilityResponseSchema,
  assistiveWorkerHeartbeatResponseSchema,
  type AssistiveWorkerHealthState,
} from '../domain/workerHeartbeatContract';
import type { AssistiveWorkerHeartbeatGateway } from '../repositories/assistiveWorkerHeartbeatRepository';

export async function hasCompatibleAssistiveWorker(
  gateway: AssistiveWorkerHeartbeatGateway,
): Promise<boolean> {
  const parsed = assistiveWorkerAvailabilityResponseSchema.safeParse(await gateway.availability());
  return parsed.success
    && parsed.data.resultCode === 'AVAILABLE'
    && parsed.data.compatibleWorkerCount > 0
    && parsed.data.latestHeartbeatAt !== null;
}

export class AssistiveWorkerHeartbeatPublisher {
  constructor(
    private readonly gateway: AssistiveWorkerHeartbeatGateway,
    private readonly workerInstanceId: string,
    private readonly deploymentVersion: string,
  ) {}

  async publish(healthState: AssistiveWorkerHealthState): Promise<void> {
    const parsed = assistiveWorkerHeartbeatResponseSchema.safeParse(await this.gateway.record({
      workerInstanceId: this.workerInstanceId,
      deploymentVersion: this.deploymentVersion,
      healthState,
    }));
    if (!parsed.success || parsed.data.resultCode !== 'HEARTBEAT_RECORDED') {
      throw new Error('ASSISTIVE_WORKER_HEARTBEAT_REJECTED');
    }
  }
}
