import { Module } from '@nitrostack/core';
import { RenderProvider } from './providers/render.provider.js';
import { VercelProvider } from './providers/vercel.provider.js';

/**
 * Deployment module providing provider abstractions for future deploy phases.
 */
@Module({
  name: 'deployment',
  description: 'Deployment abstraction module',
  providers: [VercelProvider, RenderProvider],
  exports: [VercelProvider, RenderProvider],
})
export class DeploymentModule {}
