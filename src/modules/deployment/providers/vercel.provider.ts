import { Injectable, McpError } from '@nitrostack/core';
import {
  DeploymentProvider,
  DeploymentRequest,
  DeploymentResult,
} from '../deployment.provider.js';

/**
 * Placeholder Vercel deployment provider.
 * Intentionally non-operational for Phase 1.
 */
@Injectable()
export class VercelProvider extends DeploymentProvider {
  readonly providerName = 'vercel';

  validateConfiguration(): void {
    // Phase 1 intentionally does not validate Vercel-specific configuration yet.
  }

  async createDeployment(_request: DeploymentRequest): Promise<DeploymentResult> {
    throw new McpError(
      'Vercel deployment is not implemented in Phase 1.',
      'DEPLOYMENT_NOT_IMPLEMENTED',
      501,
    );
  }
}
