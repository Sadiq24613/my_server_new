import { ConfigModule, McpApp, Module } from '@nitrostack/core';
import { SystemHealthCheck } from './health/system.health.js';
import { DeploymentModule } from './modules/deployment/deployment.module.js';
import { GitHubModule } from './modules/github/github.module.js';

/**
 * Root application module for the GitHub Deploy Agent MCP server.
 */
@McpApp({
  module: AppModule,
  server: {
    name: 'github-deploy-agent',
    version: '1.0.0',
  },
  logging: {
    level: 'info',
  },
})
@Module({
  name: 'app',
  description: 'Root module for GitHub repository automation tools',
  imports: [
    ConfigModule.forRoot({
      validate: (config) =>
        Boolean(config.NITROSTACK_API_KEY) &&
        (Boolean(config.GITHUB_OAUTH_CLIENT_ID || config.GITHUB_CLIENT_ID) ||
          Boolean(config.GITHUB_TOKEN)),
    }),
    GitHubModule,
    DeploymentModule,
  ],
  providers: [
    SystemHealthCheck,
  ],
})
export class AppModule {}
