import { Injectable, McpError } from '@nitrostack/core';
import {
  DeploymentProvider,
  DeploymentRequest,
  DeploymentResult,
} from '../deployment.provider.js';

/**
 * Placeholder Render deployment provider.
 * Intentionally non-operational for Phase 1.
 */
@Injectable()
export class RenderProvider extends DeploymentProvider {
  readonly providerName = 'render';

  validateConfiguration(): void {
    // Phase 1 intentionally does not validate Render-specific configuration yet.
  }

  async createDeployment(_request: DeploymentRequest): Promise<DeploymentResult> {
    throw new McpError(
      'Render deployment is not implemented in Phase 1.',
      'DEPLOYMENT_NOT_IMPLEMENTED',
      501,
    );
  }
}
