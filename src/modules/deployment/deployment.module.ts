import { Module } from '@nitrostack/core';
import { RenderProvider } from './providers/render.provider.js';
import { VercelProvider } from './providers/vercel.provider.js';
import { DeploymentTools } from './deployment.tools.js';

/**
 * Deployment module providing provider abstractions and tools for Render & Vercel deployment APIs.
 */
@Module({
  name: 'deployment',
  description: 'Deployment module with automated Render and Vercel tools',
  providers: [VercelProvider, RenderProvider, DeploymentTools],
  exports: [VercelProvider, RenderProvider, DeploymentTools],
})
export class DeploymentModule {}

