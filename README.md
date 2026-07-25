# GitHub Deploy Agent (NitroStack MCP Server)

Production-oriented NitroStack MCP server for GitHub repository automation.

## Implemented in Phase 1

- GitHub PAT authentication and account verification
- Repository creation, listing, lookup, tree/file/directory reads, and code search
- Branch creation/deletion
- Commit history listing plus commit creation (single and multiple files) and branch ref updates
- Pull request creation, listing, and merging
- Repository analyzer service for framework/language/package-manager detection
- Agent-first workflow tools:
  - `repo_onboarding_summary` for tech-stack detection, important files, and safe next steps
  - `apply_code_patch` for "push/save/commit this code" requests
  - `create_feature_branch_and_pr` for branch + commit + PR workflows
  - `prepare_deploy_plan` for deploy readiness, build/start commands, and Dockerfile generation
- Automated Render API deployment tools:
  - `render_list_services` to list registered Render services
  - `render_trigger_deploy` to trigger deployments programmatically
  - `render_get_deploy_status` to monitor deployment progress

## Environment Variables

Configure these in NitroCloud/Render environment variables:

```bash
RENDER_API_KEY=rnd_...   # Required to allow MCP server to interact with Render API automatically
```


No GitHub credential is required to start the server.

Required only when using GitHub browser login:

```bash
GITHUB_OAUTH_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_OAUTH_CLIENT_SECRET=your_github_oauth_app_client_secret
```

Required for browser redirect login unless `NITROSTACK_PUBLIC_URL` is provided by the platform:

```bash
RESOURCE_URI=https://your-app.nitrocloud.app
```

Your GitHub OAuth App callback URL must be:

```text
https://your-app.nitrocloud.app/auth/github/callback
```

You can override it explicitly with `GITHUB_OAUTH_REDIRECT_URI`.

Optional fallback (non-interactive):

```bash
GITHUB_TOKEN=your_github_personal_access_token
```

The user access token is created dynamically after `authenticate_github` completes the OAuth device flow. Do not set that dynamic token as an environment variable.

Optional NitroStack OAuth metadata overrides:

```bash
AUTH_SERVER_URL=https://github.com
OAUTH_REQUIRED=false
HOST=0.0.0.0
```

Set `OAUTH_REQUIRED=true` only after configuring token validation with `JWKS_URI` or the introspection variables.

## Browser GitHub Login

1. Call `authenticate_github` with `{ "action": "browser_start" }`
2. Open `authorization_url` in the browser and approve GitHub access
3. Call `authenticate_github` with `{ "action": "browser_poll", "state": "..." }` until status is `authenticated`

## Device-Code GitHub Login

1. Call `authenticate_github` with `{ "action": "start" }`
2. Open `verification_uri` and enter `user_code`
3. Call `authenticate_github` with `{ "action": "poll", "device_code": "..." }` until status is `authenticated`

## Run

```bash
npm run dev
```

## Build

```bash
npm run build
```
