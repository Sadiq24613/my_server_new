import { randomBytes } from 'node:crypto';
import { ConfigService, Injectable, McpError } from '@nitrostack/core';
import type {
  CommitFileInput,
  GitHubApiErrorDetails,
  GitHubCommitSummary,
  GitHubPullRequestSummary,
  GitHubRepositorySummary,
  GitHubTreeItem,
  GitHubUser,
  RepositoryAnalysis,
} from './github.types.js';
import { RepositoryAnalyzerService } from './repository-analyzer.service.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  token?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface GitHubDeviceCodeStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubDeviceCodePollSuccessResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubDeviceCodePollErrorResponse {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string;
  error_description?: string;
}

interface GitHubBrowserAuthSession {
  status: 'pending' | 'authenticated' | 'error';
  requestedAt: number;
  expiresAt: number;
  redirectUri: string;
  user?: GitHubUser;
  scopes?: string[];
  error?: string;
}

/**
 * Encapsulates all GitHub REST API interactions used by MCP tools.
 */
@Injectable({ deps: [ConfigService, RepositoryAnalyzerService] })
export class GitHubService {
  private readonly baseUrl = 'https://api.github.com';
  private readonly oauthBaseUrl = 'https://github.com';
  private runtimeToken?: string;
  private readonly pendingDeviceCodes = new Map<
    string,
    { requestedAt: number; expiresIn: number; interval: number }
  >();
  private readonly browserAuthSessions = new Map<string, GitHubBrowserAuthSession>();

  constructor(
    private readonly configService: ConfigService,
    private readonly repositoryAnalyzer: RepositoryAnalyzerService,
  ) {}

  /**
   * Authenticates using a provided PAT and returns the account profile.
   */
  async authenticate(token?: string): Promise<GitHubUser> {
    const resolvedToken = this.resolveToken(token);
    const user = await this.request<GitHubUser>('/user', {
      method: 'GET',
      token: resolvedToken,
    });

    this.runtimeToken = resolvedToken;
    return user;
  }

  /**
   * Starts GitHub OAuth device flow for interactive login.
   */
  async startDeviceAuthorization(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    const clientId = this.getOAuthClientId();
    const response = await this.requestOAuthForm<GitHubDeviceCodeStartResponse>(
      '/login/device/code',
      {
        client_id: clientId,
        scope: 'repo read:user',
      },
    );

    this.pendingDeviceCodes.set(response.device_code, {
      requestedAt: Date.now(),
      expiresIn: response.expires_in,
      interval: response.interval,
    });

    return {
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      expiresIn: response.expires_in,
      interval: response.interval,
    };
  }

  /**
   * Polls GitHub OAuth device flow to exchange device code for access token.
   */
  async pollDeviceAuthorization(deviceCode: string): Promise<
    | {
        status: 'pending' | 'slow_down';
        message: string;
      }
    | {
        status: 'expired' | 'denied';
        message: string;
      }
    | {
        status: 'authenticated';
        user: GitHubUser;
        scopes: string[];
      }
  > {
    const pending = this.pendingDeviceCodes.get(deviceCode);
    if (!pending) {
      throw new McpError(
        'Unknown device_code. Start authentication again with action="start".',
        'GITHUB_DEVICE_CODE_NOT_FOUND',
        400,
      );
    }

    const elapsedSeconds = Math.floor((Date.now() - pending.requestedAt) / 1000);
    if (elapsedSeconds >= pending.expiresIn) {
      this.pendingDeviceCodes.delete(deviceCode);
      return {
        status: 'expired',
        message: 'Device authorization expired. Start again with action="start".',
      };
    }

    const clientId = this.getOAuthClientId();
    const clientSecret = this.getOAuthClientSecret();

    const payload: Record<string, string> = {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    if (clientSecret) {
      payload.client_secret = clientSecret;
    }

    const response = await this.requestOAuthForm<GitHubDeviceCodePollSuccessResponse | GitHubDeviceCodePollErrorResponse>(
      '/login/oauth/access_token',
      payload,
    );

    if ('error' in response) {
      if (response.error === 'authorization_pending') {
        return { status: 'pending', message: 'Authorization pending. Ask user to finish login on GitHub.' };
      }
      if (response.error === 'slow_down') {
        return { status: 'slow_down', message: 'Poll less frequently and retry after a short delay.' };
      }
      if (response.error === 'access_denied') {
        this.pendingDeviceCodes.delete(deviceCode);
        return { status: 'denied', message: 'User denied GitHub authorization request.' };
      }
      if (response.error === 'expired_token') {
        this.pendingDeviceCodes.delete(deviceCode);
        return { status: 'expired', message: 'Device authorization expired. Start again with action="start".' };
      }

      throw new McpError(
        response.error_description ?? 'GitHub OAuth device flow failed.',
        'GITHUB_OAUTH_ERROR',
        400,
        response,
      );
    }

    this.pendingDeviceCodes.delete(deviceCode);
    this.runtimeToken = response.access_token;
    const user = await this.authenticate(response.access_token);

    return {
      status: 'authenticated',
      user,
      scopes: response.scope ? response.scope.split(',').map((value) => value.trim()).filter(Boolean) : [],
    };
  }

  /**
   * Starts GitHub OAuth authorization-code login through the user's browser.
   */
  startBrowserAuthorization(redirectUriOverride?: string): {
    authorizationUrl: string;
    callbackUrl: string;
    state: string;
    expiresIn: number;
  } {
    const clientId = this.getOAuthClientId();
    if (!this.getOAuthClientSecret()) {
      throw new McpError(
        'Browser GitHub login requires GITHUB_OAUTH_CLIENT_SECRET.',
        'GITHUB_BROWSER_AUTH_CLIENT_SECRET_REQUIRED',
        400,
      );
    }
    const callbackUrl = redirectUriOverride ?? this.getBrowserRedirectUri();
    const state = randomBytes(24).toString('hex');
    const expiresIn = 600;

    const url = new URL(`${this.oauthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', 'repo read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');

    this.browserAuthSessions.set(state, {
      status: 'pending',
      requestedAt: Date.now(),
      expiresAt: Date.now() + expiresIn * 1000,
      redirectUri: callbackUrl,
    });

    return {
      authorizationUrl: url.toString(),
      callbackUrl,
      state,
      expiresIn,
    };
  }

  /**
   * Handles GitHub's browser OAuth callback and stores the resulting runtime token.
   */
  async completeBrowserAuthorization(input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<GitHubBrowserAuthSession> {
    const session = this.browserAuthSessions.get(input.state);
    if (!session) {
      throw new McpError('Unknown or expired GitHub OAuth state.', 'GITHUB_BROWSER_AUTH_STATE_NOT_FOUND', 400);
    }

    if (Date.now() > session.expiresAt) {
      this.browserAuthSessions.delete(input.state);
      throw new McpError('GitHub OAuth browser login expired. Start login again.', 'GITHUB_BROWSER_AUTH_EXPIRED', 400);
    }

    if (input.error) {
      session.status = 'error';
      session.error = input.errorDescription ?? input.error;
      return session;
    }

    if (!input.code) {
      throw new McpError('GitHub OAuth callback did not include a code.', 'GITHUB_BROWSER_AUTH_CODE_MISSING', 400);
    }

    const payload: Record<string, string> = {
      client_id: this.getOAuthClientId(),
      code: input.code,
      redirect_uri: session.redirectUri,
    };
    const clientSecret = this.getOAuthClientSecret();
    if (clientSecret) {
      payload.client_secret = clientSecret;
    }

    const response = await this.requestOAuthForm<
      GitHubDeviceCodePollSuccessResponse | GitHubDeviceCodePollErrorResponse
    >('/login/oauth/access_token', payload);

    if ('error' in response) {
      session.status = 'error';
      session.error = response.error_description ?? response.error;
      return session;
    }

    this.runtimeToken = response.access_token;
    const user = await this.authenticate(response.access_token);
    session.status = 'authenticated';
    session.user = user;
    session.scopes = response.scope ? response.scope.split(',').map((value) => value.trim()).filter(Boolean) : [];
    return session;
  }

  pollBrowserAuthorization(state: string): GitHubBrowserAuthSession {
    const session = this.browserAuthSessions.get(state);
    if (!session) {
      throw new McpError('Unknown GitHub OAuth state. Start browser login again.', 'GITHUB_BROWSER_AUTH_STATE_NOT_FOUND', 400);
    }

    if (Date.now() > session.expiresAt) {
      this.browserAuthSessions.delete(state);
      throw new McpError('GitHub OAuth browser login expired. Start login again.', 'GITHUB_BROWSER_AUTH_EXPIRED', 400);
    }

    return session;
  }

  /**
   * Lists repositories available to the authenticated user.
   */
  async listRepositories(
    input: {
      visibility: 'all' | 'public' | 'private';
      affiliation: string;
      sort: 'created' | 'updated' | 'pushed' | 'full_name';
      direction: 'asc' | 'desc';
      per_page: number;
      page: number;
    },
    token?: string,
  ): Promise<GitHubRepositorySummary[]> {
    return this.request<GitHubRepositorySummary[]>('/user/repos', {
      method: 'GET',
      token,
      query: input,
    });
  }

  /**
   * Creates a new repository under the authenticated account.
   */
  async createRepository(
    input: {
      name: string;
      description?: string;
      private: boolean;
      auto_init: boolean;
      gitignore_template?: string;
      license_template?: string;
    },
    token?: string,
  ): Promise<GitHubRepositorySummary> {
    return this.request<GitHubRepositorySummary>('/user/repos', {
      method: 'POST',
      token,
      body: input,
    });
  }

  /**
   * Returns metadata for a specific repository.
   */
  async getRepository(owner: string, repo: string, token?: string): Promise<GitHubRepositorySummary> {
    return this.request<GitHubRepositorySummary>(`/repos/${owner}/${repo}`, {
      method: 'GET',
      token,
    });
  }

  /**
   * Lists commit history for a repository.
   */
  async listCommitHistory(
    owner: string,
    repo: string,
    input: {
      sha?: string;
      path?: string;
      per_page: number;
      page: number;
    },
    token?: string,
  ): Promise<GitHubCommitSummary[]> {
    return this.request<GitHubCommitSummary[]>(`/repos/${owner}/${repo}/commits`, {
      method: 'GET',
      token,
      query: input,
    });
  }

  /**
   * Reads repository tree from a branch, tag, or commit reference.
   */
  async readRepositoryTree(
    owner: string,
    repo: string,
    ref: string,
    recursive: boolean,
    filterPath?: string,
    token?: string,
  ): Promise<{ ref: string; commitSha: string; treeSha: string; truncated: boolean; tree: GitHubTreeItem[] }> {
    const resolvedRef = await this.resolveReference(owner, repo, ref, token);

    const commit = await this.request<{ sha: string; commit: { tree: { sha: string } } }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(resolvedRef)}`,
      {
        method: 'GET',
        token,
      },
    );

    const treeResponse = await this.request<{ sha: string; truncated: boolean; tree: GitHubTreeItem[] }>(
      `/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}`,
      {
        method: 'GET',
        token,
        query: { recursive: recursive ? 1 : undefined },
      },
    );

    const normalizedPrefix = filterPath?.replace(/^\/+/, '').replace(/\/+$/, '');
    const filteredTree =
      normalizedPrefix && normalizedPrefix.length > 0
        ? treeResponse.tree.filter((item) => item.path === normalizedPrefix || item.path.startsWith(`${normalizedPrefix}/`))
        : treeResponse.tree;

    return {
      ref: resolvedRef,
      commitSha: commit.sha,
      treeSha: treeResponse.sha,
      truncated: treeResponse.truncated,
      tree: filteredTree,
    };
  }

  /**
   * Reads file contents from a repository path.
   */
  async readFile(
    owner: string,
    repo: string,
    filePath: string,
    ref?: string,
    token?: string,
  ): Promise<{
    path: string;
    sha: string;
    size: number;
    encoding: string;
    contentBase64: string;
    contentUtf8: string;
    htmlUrl?: string;
  }> {
    const content = await this.request<{
      path: string;
      sha: string;
      size: number;
      encoding: string;
      content: string;
      html_url?: string;
      type: string;
    } | Array<unknown>>(`/repos/${owner}/${repo}/contents/${this.encodePath(filePath)}`, {
      method: 'GET',
      token,
      query: { ref },
    });

    if (Array.isArray(content) || !('type' in content) || content.type !== 'file') {
      throw new McpError(
        `Path "${filePath}" is not a file.`,
        'GITHUB_NOT_A_FILE',
        400,
      );
    }

    const contentBase64 = content.content.replace(/\n/g, '');
    const contentUtf8 =
      content.encoding === 'base64'
        ? Buffer.from(contentBase64, 'base64').toString('utf-8')
        : content.content;

    return {
      path: content.path,
      sha: content.sha,
      size: content.size,
      encoding: content.encoding,
      contentBase64,
      contentUtf8,
      htmlUrl: content.html_url,
    };
  }

  /**
   * Lists immediate contents of a directory.
   */
  async readDirectory(
    owner: string,
    repo: string,
    directoryPath = '',
    ref?: string,
    token?: string,
  ): Promise<
    Array<{
      name: string;
      path: string;
      sha: string;
      type: 'file' | 'dir' | string;
      size?: number;
      html_url?: string;
    }>
  > {
    const normalizedPath = directoryPath.replace(/^\/+/, '');
    const requestPath =
      normalizedPath.length > 0
        ? `/repos/${owner}/${repo}/contents/${this.encodePath(normalizedPath)}`
        : `/repos/${owner}/${repo}/contents`;

    const content = await this.request<
      | {
          type: string;
          path: string;
        }
      | Array<{
          name: string;
          path: string;
          sha: string;
          type: 'file' | 'dir' | string;
          size?: number;
          html_url?: string;
        }>
    >(requestPath, {
      method: 'GET',
      token,
      query: { ref },
    });

    if (!Array.isArray(content)) {
      throw new McpError(
        `Path "${directoryPath}" is not a directory.`,
        'GITHUB_NOT_A_DIRECTORY',
        400,
      );
    }

    return content;
  }

  /**
   * Searches code in a repository using GitHub code search.
   */
  async searchRepository(
    owner: string,
    repo: string,
    query: string,
    options: {
      path?: string;
      language?: string;
      per_page: number;
      page: number;
    },
    token?: string,
  ): Promise<{
    total_count: number;
    incomplete_results: boolean;
    items: Array<{
      name: string;
      path: string;
      sha: string;
      html_url: string;
      repository: { full_name: string };
    }>;
  }> {
    const queryParts = [query, `repo:${owner}/${repo}`];
    if (options.path) {
      queryParts.push(`path:${options.path}`);
    }
    if (options.language) {
      queryParts.push(`language:${options.language}`);
    }

    return this.request('/search/code', {
      method: 'GET',
      token,
      query: {
        q: queryParts.join(' '),
        per_page: options.per_page,
        page: options.page,
      },
    });
  }

  /**
   * Creates a branch from an existing reference.
   */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromRef: string,
    token?: string,
  ): Promise<{ ref: string; sha: string }> {
    const fromSha = await this.getRefSha(owner, repo, fromRef, token);
    const result = await this.request<{ ref: string; object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs`,
      {
        method: 'POST',
        token,
        body: {
          ref: `refs/heads/${branch}`,
          sha: fromSha,
        },
      },
    );

    return { ref: result.ref, sha: result.object.sha };
  }

  /**
   * Deletes an existing branch reference.
   */
  async deleteBranch(owner: string, repo: string, branch: string, token?: string): Promise<{ deleted: boolean }> {
    await this.request<void>(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      token,
    });
    return { deleted: true };
  }

  /**
   * Creates a single-file commit and updates the target branch ref.
   */
  async createCommit(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    filePath: string,
    content: string,
    encoding: 'utf-8' | 'base64',
    token?: string,
  ): Promise<{ branch: string; previousCommitSha: string; commitSha: string; treeSha: string }> {
    return this.commitFiles(
      owner,
      repo,
      branch,
      message,
      [
        {
          path: filePath,
          content,
          encoding,
          mode: '100644',
        },
      ],
      token,
    );
  }

  /**
   * Creates a multi-file commit and updates the target branch ref.
   */
  async commitMultipleFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: CommitFileInput[],
    token?: string,
  ): Promise<{ branch: string; previousCommitSha: string; commitSha: string; treeSha: string }> {
    return this.commitFiles(owner, repo, branch, message, files, token);
  }

  /**
   * Updates branch reference to point to an existing commit SHA (push-like ref update).
   */
  async pushChanges(
    owner: string,
    repo: string,
    branch: string,
    commitSha: string,
    force: boolean,
    token?: string,
  ): Promise<{ branch: string; commitSha: string; forced: boolean }> {
    await this.request<{ ref: string; object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        token,
        body: { sha: commitSha, force },
      },
    );

    return {
      branch,
      commitSha,
      forced: force,
    };
  }

  /**
   * Creates a pull request.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    input: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft: boolean;
    },
    token?: string,
  ): Promise<GitHubPullRequestSummary> {
    return this.request<GitHubPullRequestSummary>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      token,
      body: input,
    });
  }

  /**
   * Lists pull requests in a repository.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    input: {
      state: 'open' | 'closed' | 'all';
      head?: string;
      base?: string;
      sort: 'created' | 'updated' | 'popularity' | 'long-running';
      direction: 'asc' | 'desc';
      per_page: number;
      page: number;
    },
    token?: string,
  ): Promise<GitHubPullRequestSummary[]> {
    return this.request<GitHubPullRequestSummary[]>(`/repos/${owner}/${repo}/pulls`, {
      method: 'GET',
      token,
      query: input,
    });
  }

  /**
   * Merges a pull request with merge/squash/rebase strategy.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    input: {
      commit_title?: string;
      commit_message?: string;
      merge_method: 'merge' | 'squash' | 'rebase';
    },
    token?: string,
  ): Promise<{ sha: string; merged: boolean; message: string }> {
    return this.request<{ sha: string; merged: boolean; message: string }>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      {
        method: 'PUT',
        token,
        body: input,
      },
    );
  }

  /**
   * Analyzes repository technologies using repository tree signals.
   */
  async analyzeRepository(owner: string, repo: string, ref = 'HEAD', token?: string): Promise<RepositoryAnalysis> {
    const tree = await this.readRepositoryTree(owner, repo, ref, true, undefined, token);
    const paths = tree.tree.map((item) => item.path);
    const fileContents: Record<string, string> = {};

    if (paths.includes('package.json')) {
      const packageJson = await this.readFile(owner, repo, 'package.json', tree.ref, token);
      fileContents['package.json'] = packageJson.contentUtf8;
    }
    if (paths.includes('requirements.txt')) {
      const requirements = await this.readFile(owner, repo, 'requirements.txt', tree.ref, token);
      fileContents['requirements.txt'] = requirements.contentUtf8;
    }
    if (paths.includes('pyproject.toml')) {
      const pyproject = await this.readFile(owner, repo, 'pyproject.toml', tree.ref, token);
      fileContents['pyproject.toml'] = pyproject.contentUtf8;
    }

    return this.repositoryAnalyzer.analyze(paths, fileContents);
  }

  private async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: CommitFileInput[],
    token?: string,
  ): Promise<{ branch: string; previousCommitSha: string; commitSha: string; treeSha: string }> {
    const headSha = await this.getRefSha(owner, repo, `heads/${branch}`, token);
    const headCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${headSha}`,
      {
        method: 'GET',
        token,
      },
    );

    const treeEntries: Array<{ path: string; mode: string; type: 'blob'; sha: string }> = [];
    for (const file of files) {
      const blob = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        token,
        body: {
          content: file.content,
          encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
        },
      });
      treeEntries.push({
        path: file.path,
        mode: file.mode,
        type: 'blob',
        sha: blob.sha,
      });
    }

    const tree = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      token,
      body: {
        base_tree: headCommit.tree.sha,
        tree: treeEntries,
      },
    });

    const commit = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      token,
      body: {
        message,
        tree: tree.sha,
        parents: [headSha],
      },
    });

    await this.request(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      token,
      body: { sha: commit.sha, force: false },
    });

    return {
      branch,
      previousCommitSha: headSha,
      commitSha: commit.sha,
      treeSha: tree.sha,
    };
  }

  private async getRefSha(owner: string, repo: string, ref: string, token?: string): Promise<string> {
    const normalizedRef = this.normalizeRef(ref);
    const branchRef = await this.request<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(normalizedRef)}`,
      {
        method: 'GET',
        token,
      },
    );

    return branchRef.object.sha;
  }

  private async resolveReference(owner: string, repo: string, ref: string, token?: string): Promise<string> {
    if (ref !== 'HEAD') {
      return ref;
    }

    const repository = await this.getRepository(owner, repo, token);
    return repository.default_branch;
  }

  private normalizeRef(ref: string): string {
    const withoutPrefix = ref.startsWith('refs/') ? ref.slice(5) : ref;
    if (withoutPrefix.startsWith('heads/') || withoutPrefix.startsWith('tags/')) {
      return withoutPrefix;
    }

    return `heads/${withoutPrefix}`;
  }

  private resolveToken(token?: string): string {
    const explicitToken = token?.trim();
    if (explicitToken) {
      return explicitToken;
    }

    if (this.runtimeToken) {
      return this.runtimeToken;
    }

    const envToken = this.configService.get<string>('GITHUB_TOKEN');
    if (envToken) {
      return envToken;
    }

    throw new McpError(
      'No GitHub token available. Run authenticate_github with OAuth action="start" and action="poll".',
      'GITHUB_AUTH_REQUIRED',
      401,
    );
  }

  private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const token = this.resolveToken(options.token);
    const url = new URL(`${this.baseUrl}${endpoint}`);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'github-deploy-agent',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const rawBody = await response.text();
    const parsedBody = this.tryParseJson(rawBody);

    if (!response.ok) {
      const details: GitHubApiErrorDetails = {
        status: response.status,
        statusText: response.statusText,
        responseBody: parsedBody ?? rawBody,
      };

      throw new McpError(
        this.extractGitHubErrorMessage(details) ?? 'GitHub API request failed.',
        'GITHUB_API_ERROR',
        response.status,
        details,
      );
    }

    return (parsedBody as T) ?? (undefined as T);
  }

  private tryParseJson(value: string): unknown | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private extractGitHubErrorMessage(details: GitHubApiErrorDetails): string | undefined {
    if (
      details.responseBody &&
      typeof details.responseBody === 'object' &&
      details.responseBody !== null &&
      'message' in details.responseBody &&
      typeof (details.responseBody as { message?: unknown }).message === 'string'
    ) {
      return (details.responseBody as { message: string }).message;
    }

    return undefined;
  }

  private encodePath(path: string): string {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private getOAuthClientId(): string {
    const clientId =
      this.configService.get<string>('GITHUB_OAUTH_CLIENT_ID') ??
      this.configService.get<string>('GITHUB_CLIENT_ID');
    if (!clientId) {
      throw new McpError(
        'GitHub OAuth login requires GITHUB_OAUTH_CLIENT_ID.',
        'GITHUB_OAUTH_CLIENT_ID_REQUIRED',
        400,
      );
    }

    return clientId;
  }

  private getOAuthClientSecret(): string | undefined {
    return (
      this.configService.get<string>('GITHUB_OAUTH_CLIENT_SECRET') ??
      this.configService.get<string>('GITHUB_CLIENT_SECRET')
    );
  }

  private getBrowserRedirectUri(): string {
    const explicitRedirectUri = this.configService.get<string>('GITHUB_OAUTH_REDIRECT_URI');
    if (explicitRedirectUri) {
      return explicitRedirectUri;
    }

    const publicBaseUrl =
      this.configService.get<string>('RESOURCE_URI') ??
      this.configService.get<string>('NITROSTACK_PUBLIC_URL');
    if (!publicBaseUrl) {
      throw new McpError(
        'Browser GitHub login requires GITHUB_OAUTH_REDIRECT_URI, RESOURCE_URI, or NITROSTACK_PUBLIC_URL.',
        'GITHUB_BROWSER_AUTH_REDIRECT_URI_REQUIRED',
        400,
      );
    }

    return `${publicBaseUrl.replace(/\/$/, '')}/auth/github/callback`;
  }

  private async requestOAuthForm<T>(
    endpoint: string,
    payload: Record<string, string>,
  ): Promise<T> {
    const url = `${this.oauthBaseUrl}${endpoint}`;
    const body = new URLSearchParams(payload);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'github-deploy-agent',
      },
      body: body.toString(),
    });

    const rawBody = await response.text();
    const parsedBody = this.tryParseJson(rawBody);

    if (!response.ok) {
      throw new McpError(
        'GitHub OAuth request failed.',
        'GITHUB_OAUTH_HTTP_ERROR',
        response.status,
        {
          status: response.status,
          statusText: response.statusText,
          responseBody: parsedBody ?? rawBody,
        },
      );
    }

    return parsedBody as T;
  }
}
