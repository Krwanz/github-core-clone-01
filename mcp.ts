// mcp.ts — the MCP surface at POST /mcp: JSON-RPC 2.0 Streamable HTTP.
//
// Two eras, one endpoint, as the suite's client speaks them:
//   modern  2026-07-28 — server/discover answers supportedVersions, capabilities
//           and serverInfo in one request; every later request declares its
//           revision in _meta and the MCP-Protocol-Version header.
//   legacy  2025-11-25 and earlier — initialize negotiates a revision, then
//           notifications/initialized, with an Mcp-Session-Id from then on.
// The modern era is answered first (the client's connect() probes discover),
// the legacy handshake is kept for a client that predates discover.
//
// The six tools share the REST store: a repo or issue made here is the same
// object over REST, with the same ids. Every request answers inside 3 s;
// the work here is all in-memory and synchronous.

import { NOW_ISO, VIEWER_USER, type Store } from './store.ts';
import {
  createIssueInStore,
  createPullInStore,
  isAuthorized,
  issueJson,
  pullJson,
  repoJson,
  type RestRequest,
  type RestResponse,
} from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

/** The one tools array, built once so tools/list is byte-identical every call. */
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach; they must exist on the repository.' },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['repo', 'head', 'base', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first defined value among an argument's names (the suite's synonyms). */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

let sessionCounter = 1;

export function handleMcp(store: Store, request: RestRequest): RestResponse {
  const jsonHeaders = { 'content-type': 'application/json' };
  if (!isAuthorized(request)) {
    return {
      status: 401,
      headers: jsonHeaders,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }), 'utf8'),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      headers: jsonHeaders,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return {
      status: 400,
      headers: jsonHeaders,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), 'utf8'),
    };
  }
  const id = parsed.id === undefined ? null : parsed.id;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A notification (no id) is answered with 202 and no body.
  if (id === null) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  const answer = (result: unknown, extraHeaders: Record<string, string> = {}): RestResponse => ({
    status: 200,
    headers: { ...jsonHeaders, ...extraHeaders },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
  });
  const errorAnswer = (code: number, message: string, data?: unknown): RestResponse => ({
    status: 200,
    headers: jsonHeaders,
    body: Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
      'utf8',
    ),
  });

  if (method === 'server/discover') {
    return answer({
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0] as string;
    const sessionId = `session-${sessionCounter++}`;
    return answer(
      {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
      { 'mcp-session-id': sessionId },
    );
  }

  if (method === 'ping') {
    return answer({});
  }

  if (method === 'tools/list') {
    return answer({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return errorAnswer(-32602, `Unknown tool: ${name}`);
    }
    const missing = tool.inputSchema.required.filter((required) => {
      // A required property counts as present under any of its synonyms.
      const synonyms: Record<string, string[]> = {
        repo: ['repo', 'repository', 'repository_name', 'repo_name'],
        pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number'],
      };
      const names = synonyms[required] ?? [required];
      return pick(args, ...names) === undefined;
    });
    if (missing.length > 0) {
      return answer(toolError(`Missing required argument(s): ${missing.join(', ')}`));
    }
    return answer(callTool(store, tool.name, args));
  }

  return errorAnswer(-32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = asString(pick(args, 'owner', 'owner_login', 'org', 'user_login', 'login')) || VIEWER_USER.login;
  const repoName = asString(pick(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name'));
  switch (name) {
    case 'create_repo': {
      const repoNameArg = asString(pick(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name'));
      if (repoNameArg === '') return toolError('name is required');
      if (store.getRepo(owner, repoNameArg) !== undefined) {
        return toolError(`Repository ${owner}/${repoNameArg} already exists`);
      }
      const description = asString(pick(args, 'description', 'about', 'summary', 'body'));
      const isPrivate = pick(args, 'private', 'is_private') === true;
      const repo = store.createRepo(owner, repoNameArg, isPrivate, description);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const title = asString(pick(args, 'title', 'issue_title', 'subject'));
      if (title === '') return toolError('title is required');
      const body = asString(pick(args, 'body', 'issue_body', 'description', 'content', 'text'));
      const labelsRaw = pick(args, 'labels');
      const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((entry): entry is string => typeof entry === 'string') : [];
      const unknown = labels.find((label) => !repo.labels.has(label));
      if (unknown !== undefined) return toolError(`Label does not exist: ${unknown}`);
      const issue = createIssueInStore(store, repo, title, body, labels);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = asString(pick(args, 'state', 'status')) || 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const title = asString(pick(args, 'title', 'pr_title', 'pull_request_title', 'subject'));
      const body = asString(pick(args, 'body', 'description', 'content', 'text'));
      const head = asString(pick(args, 'head', 'head_ref', 'head_branch', 'source_branch', 'branch'));
      const base = asString(pick(args, 'base', 'base_ref', 'base_branch', 'target_branch', 'into_branch'));
      const created = createPullInStore(store, repo, title, body, head, base);
      if ('error' in created) return toolError(created.error);
      return toolResult(pullJson(store, repo, created));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const numberRaw = pick(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
      const number = typeof numberRaw === 'number' ? numberRaw : parseInt(String(numberRaw ?? ''), 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`Pull request #${String(number)} not found`);
      if (pull.merged) return toolError('Pull request has already been merged');
      if (pull.state !== 'open') return toolError('Pull request is closed');
      const merged = store.squashMerge(repo, pull);
      if (merged === null) return toolError('Pull request is not mergeable');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = NOW_ISO;
      pull.mergeCommitSha = merged;
      return toolResult({ sha: merged, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}
