import { Injectable, ToolDecorator as Tool } from '@nitrostack/core';
import { z } from 'zod';
import { RenderProvider } from './providers/render.provider.js';

@Injectable()
export class DeploymentTools {
  constructor(private renderProvider: RenderProvider) {}

  @Tool({
    name: 'render_list_services',
    description: 'List all services on Render associated with the Render API key.',
    inputSchema: z.object({
      renderApiKey: z
        .string()
        .optional()
        .describe('Render API key. If omitted, RENDER_API_KEY environment variable will be used.'),
    }),
  })
  async listServices(input: { renderApiKey?: string }) {
    const services = await this.renderProvider.listServices(input.renderApiKey);
    return {
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        repo: s.repo,
        updatedAt: s.updatedAt,
      })),
    };
  }

  @Tool({
    name: 'render_trigger_deploy',
    description: 'Trigger a deployment for a specific Render service.',
    inputSchema: z.object({
      serviceId: z.string().describe('The Render Service ID (e.g. srv-cxxxxxx)'),
      clearCache: z.boolean().optional().describe('Whether to clear build cache before deploying.'),
      renderApiKey: z
        .string()
        .optional()
        .describe('Render API key. If omitted, RENDER_API_KEY environment variable will be used.'),
    }),
  })
  async triggerDeploy(input: { serviceId: string; clearCache?: boolean; renderApiKey?: string }) {
    const deploy = await this.renderProvider.triggerDeploy(
      input.serviceId,
      input.clearCache,
      input.renderApiKey,
    );
    return {
      message: `Deploy triggered successfully for service ${input.serviceId}`,
      deployId: deploy.id,
      status: deploy.status,
      createdAt: deploy.createdAt,
    };
  }

  @Tool({
    name: 'render_get_deploy_status',
    description: 'Check the status of a specific deployment on Render.',
    inputSchema: z.object({
      serviceId: z.string().describe('The Render Service ID'),
      deployId: z.string().describe('The Render Deploy ID'),
      renderApiKey: z
        .string()
        .optional()
        .describe('Render API key. If omitted, RENDER_API_KEY environment variable will be used.'),
    }),
  })
  async getDeployStatus(input: { serviceId: string; deployId: string; renderApiKey?: string }) {
    const status = await this.renderProvider.getDeployStatus(
      input.serviceId,
      input.deployId,
      input.renderApiKey,
    );
    return status;
  }
}
