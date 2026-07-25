# GitHub Deploy Agent (NitroStack MCP Server)

Production-oriented NitroStack MCP server for GitHub repository automation.

## Implemented in Phase 1

- GitHub PAT authentication and account verification
- Repository creation, listing, lookup, tree/file/directory reads, and code search
- Branch creation/deletion
- Commit history listing plus commit creation (single and multiple files) and branch ref updates
- Pull request creation, listing, and merging
- Repository analyzer service for framework/language/package-manager detection
- Deployment provider abstraction (`VercelProvider`, `RenderProvider`) prepared for Phase 2

## Environment Variables

Set both values before starting the server:

```bash
NITROSTACK_API_KEY=your_nitrostack_api_key
GITHUB_OAUTH_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_OAUTH_CLIENT_SECRET=your_github_oauth_app_client_secret
```

Optional fallback (non-interactive):

```bash
GITHUB_TOKEN=your_github_personal_access_token
```

## Interactive GitHub OAuth Login

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
