// rest.ts — the REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors
// carry a JSON body with a string `message`; an unknown route is a JSON 404 and
// a malformed JSON body a 400. A missing or wrong Bearer token is 401. A repo
// addressed under the wrong owner is 404, never 403.
//
// The same store the git, GraphQL and MCP surfaces read: an issue created here
// is the same issue GraphQL and MCP see, with the same number and id.

import {
  DEFAULT_BRANCH,
  NOW_ISO,
  SCENARIO_ORG,
  SCENARIO_USERS,
  VIEWER_USER,
  globalId,
  hashObject,
  isObjectId,
  parseIdentity,
  parseTree,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** The decoded path, without the query string. */
  path: string;
  query: URLSearchParams;
  /** Lower-cased header names. */
  headers: Map<string, string>;
  host: string;
  body: Buffer;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonResponse(store: Store, status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': store.nextRequest(), ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function errorResponse(store: Store, status: number, message: string): RestResponse {
  return jsonResponse(store, status, { message });
}

function noContentResponse(store: Store): RestResponse {
  return { status: 204, headers: { 'x-github-request-id': store.nextRequest() }, body: Buffer.alloc(0) };
}

function bearerToken(request: RestRequest): string | null {
  const header = request.headers.get('authorization');
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

export function isAuthorized(request: RestRequest): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const token = bearerToken(request);
  if (token === null || token === '') return false;
  // With no token configured (local runs), any Bearer token is accepted.
  if (expected === undefined || expected === '') return true;
  return token === expected;
}

/** Parse the request body as JSON. Returns null on an empty body, or throws on malformed JSON. */
function parseJsonBody(request: RestRequest): unknown {
  const text = request.body.toString('utf8');
  if (text.trim() === '') return null;
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (!isRecord(value)) return '';
  const found = value[field];
  return typeof found === 'string' ? found : '';
}

function booleanField(value: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(value)) return fallback;
  const found = value[field];
  return typeof found === 'boolean' ? found : fallback;
}

/** A page of a list, with GitHub's Link header when there is another page. */
function paginate<T>(request: RestRequest, items: T[], basePath: string): { page: T[]; link: string | null } {
  const perPageRaw = request.query.get('per_page');
  const pageRaw = request.query.get('page');
  let perPage = perPageRaw === null ? 30 : parseInt(perPageRaw, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = pageRaw === null ? 1 : parseInt(pageRaw, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const url = (targetPage: number): string => {
    const params = new URLSearchParams(request.query);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `http://${request.host}${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  if (page < totalPages) {
    links.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

function userJson(login: string, id: number, type: string): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`User:${id}`).toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type,
    site_admin: false,
  };
}

function viewerJson(): Record<string, unknown> {
  return userJson(VIEWER_USER.login, VIEWER_USER.id, 'User');
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const ownerType = repo.owner === SCENARIO_ORG ? 'Organization' : 'User';
  const ownerId = repo.owner === SCENARIO_ORG ? 2000 : (SCENARIO_USERS.find((user) => user.login === repo.owner)?.id ?? VIEWER_USER.id);
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, ownerId, ownerType),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    pushed_at: NOW_ISO,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const index = [...repo.labels.keys()].indexOf(name);
  return {
    id: repo.id * 10000 + Math.max(0, index),
    node_id: Buffer.from(`Label:${repo.id}:${name}`).toString('base64'),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: '',
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const closedAt = issue.state === 'closed' ? NOW_ISO : null;
  return {
    id: repo.id * 100000 + issue.number,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: viewerJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
  };
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const closedAt = pull.state === 'closed' ? NOW_ISO : null;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: viewerJson(),
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${headTip}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip,
      user: viewerJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip,
      user: viewerJson(),
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    merged: pull.merged,
    mergeable: store.mergeableOf(repo, pull) === 'MERGEABLE',
    mergeable_state: pull.state === 'open' ? (store.mergeableOf(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? viewerJson() : null,
  };
}

function commitJson(store: Store, repo: RepoRec, oid: string): Record<string, unknown> | null {
  const parsed = store.commitOf(repo, oid);
  if (parsed === null) return null;
  const author = parseIdentity(parsed.authorLine);
  const committer = parseIdentity(parsed.committerLine);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${repo.id}:${oid}`).toString('base64'),
    commit: {
      author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
      message: parsed.message,
      tree: { sha: parsed.tree, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${parsed.tree}` },
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: null,
    committer: null,
    parents: parsed.parents.map((parent) => ({
      sha: parent,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function createIssueInStore(
  store: Store,
  repo: RepoRec,
  title: string,
  body: string,
  labels: string[],
): IssueRec {
  const number = repo.nextNumber++;
  const issue: IssueRec = {
    number,
    id: globalId('Issue', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    labels,
    createdSeq: repo.nextNumber,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullInStore(
  store: Store,
  repo: RepoRec,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): PullRec | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  if (headTip === undefined) return { error: `head branch ${headRef} does not exist` };
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (baseTip === undefined) return { error: `base branch ${baseRef} does not exist` };
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
  if (duplicate !== undefined) return { error: 'a pull request is already open for this head and base' };
  const number = repo.nextNumber++;
  const pull: PullRec = {
    number,
    id: globalId('PullRequest', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: repo.nextNumber,
  };
  repo.pulls.push(pull);
  return pull;
}

/** The repo a path addresses, or null. Any owner other than the repo's own is a 404. */
function repoAt(store: Store, owner: string, name: string): RepoRec | null {
  return store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------

export async function handleRest(store: Store, request: RestRequest): Promise<RestResponse> {
  const path = request.path;
  if (!path.startsWith('/api/v3')) {
    return errorResponse(store, 404, 'Not Found');
  }
  if (!isAuthorized(request)) {
    return errorResponse(store, 401, 'Requires authentication');
  }
  let body: unknown = null;
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE') {
    try {
      body = parseJsonBody(request);
    } catch {
      return errorResponse(store, 400, 'Problems parsing JSON');
    }
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  // segments[0] = 'api', segments[1] = 'v3', then the route.
  const rest = segments.slice(2);

  // GET /api/v3/
  if (rest.length === 0) {
    if (request.method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(
      store,
      200,
      {
        current_user_url: 'https://api.github.com/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: 'https://api.github.com/authorizations',
        repository_url: 'https://api.github.com/repos/{owner}/{repo}',
        user_url: 'https://api.github.com/users/{user}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (request.method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (request.method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, {
      ...viewerJson(),
      name: VIEWER_USER.name,
      email: VIEWER_USER.email,
      company: '',
      blog: '',
      location: '',
      bio: '',
      public_repos: store.reposOf(VIEWER_USER.login).length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });
  }

  // GET /api/v3/users/{login}
  if (rest.length === 2 && rest[0] === 'users') {
    if (request.method !== 'GET') return errorResponse(store, 404, 'Not Found');
    const user = SCENARIO_USERS.find((candidate) => candidate.login === rest[1]);
    if (user === undefined) return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, { ...userJson(user.login, user.id, 'User'), name: user.name, email: user.email });
  }

  // GET /api/v3/orgs/{org}
  if (rest.length === 2 && rest[0] === 'orgs') {
    if (request.method !== 'GET') return errorResponse(store, 404, 'Not Found');
    if (rest[1] !== SCENARIO_ORG) return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, {
      ...userJson(SCENARIO_ORG, 2000, 'Organization'),
      name: SCENARIO_ORG,
      description: '',
      public_repos: 0,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (request.method === 'GET') {
      const repos = [...store.reposOf(VIEWER_USER.login)].reverse();
      const { page, link } = paginate(request, repos, '/api/v3/user/repos');
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return jsonResponse(store, 200, page.map((repo) => repoJson(repo)), headers);
    }
    if (request.method === 'POST') {
      const name = stringField(body, 'name');
      if (name === '' || !REPO_NAME_RE.test(name)) {
        return errorResponse(store, 422, 'name is required and must be a valid repository name');
      }
      if (store.getRepo(VIEWER_USER.login, name) !== undefined) {
        return errorResponse(store, 422, 'Repository creation failed. Name already exists on this account.');
      }
      const repo = store.createRepo(VIEWER_USER.login, name, booleanField(body, 'private', false), stringField(body, 'description'));
      return jsonResponse(store, 201, repoJson(repo));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = repoAt(store, owner, name);
    if (repo === null) return errorResponse(store, 404, 'Not Found');
    const tail = rest.slice(3);
    return handleRepoRoute(store, request, repo, tail, body);
  }

  return errorResponse(store, 404, 'Not Found');
}

function handleRepoRoute(
  store: Store,
  request: RestRequest,
  repo: RepoRec,
  tail: string[],
  body: unknown,
): RestResponse {
  const method = request.method;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return jsonResponse(store, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      return jsonResponse(store, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return noContentResponse(store);
    }
    return errorResponse(store, 404, 'Not Found');
  }

  const head = tail[0] as string;

  // GET /branches, GET /branches/{branch}
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => branchJson(repo, name.slice('refs/heads/'.length)));
      return jsonResponse(store, 200, branches);
    }
    if (method === 'GET' && tail.length === 2) {
      const branch = tail[1] as string;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return errorResponse(store, 404, 'Branch not found');
      return jsonResponse(store, 200, branchJson(repo, branch));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // GET /tags
  if (head === 'tags') {
    if (method === 'GET' && tail.length === 1) {
      const tags = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/tags/'))
        .sort()
        .map((name) => {
          const tagName = name.slice('refs/tags/'.length);
          const oid = repo.refs.get(name) as string;
          const object = repo.objects.get(oid);
          let commitSha = oid;
          if (object !== undefined && object.type === 'tag') {
            const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
            if (match !== null) commitSha = match[1] as string;
          }
          return {
            name: tagName,
            commit: { sha: commitSha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${commitSha}` },
            zipball_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/zipball/refs/tags/${tagName}`,
            tarball_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/tarball/refs/tags/${tagName}`,
            node_id: Buffer.from(`Ref:${repo.id}:refs/tags/${tagName}`).toString('base64'),
          };
        });
      return jsonResponse(store, 200, tags);
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // GET /commits, GET /commits/{sha}
  if (head === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const shaParam = request.query.get('sha');
      let tip: string | undefined;
      if (shaParam === null) {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      } else if (repo.refs.has(`refs/heads/${shaParam}`)) {
        tip = repo.refs.get(`refs/heads/${shaParam}`);
      } else if (isObjectId(shaParam) && repo.objects.has(shaParam)) {
        tip = shaParam;
      } else {
        return errorResponse(store, 404, 'No commit found for SHA');
      }
      if (tip === undefined) return jsonResponse(store, 200, []);
      const commits = store.reachableCommits(repo, [tip]);
      const { page, link } = paginate(request, commits, `${base}/commits`);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      const items = page.map((oid) => commitJson(store, repo, oid)).filter((entry): entry is Record<string, unknown> => entry !== null);
      return jsonResponse(store, 200, items, headers);
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = tail[1] as string;
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') return errorResponse(store, 404, 'No commit found for SHA');
      return jsonResponse(store, 200, commitJson(store, repo, sha));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // /git/refs...
  if (head === 'git' && tail[1] === 'refs') {
    return handleGitRefs(store, request, repo, tail.slice(2), body);
  }

  // /contents/{path...}
  if (head === 'contents') {
    return handleContents(store, request, repo, tail.slice(1), body);
  }

  // /labels
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return jsonResponse(store, 200, [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
    }
    if (method === 'POST' && tail.length === 1) {
      const name = stringField(body, 'name');
      if (name === '') return errorResponse(store, 422, 'name is required');
      if (repo.labels.has(name)) return errorResponse(store, 422, 'Label already exists');
      const color = stringField(body, 'color') || 'ededed';
      repo.labels.set(name, { name, color });
      return jsonResponse(store, 201, labelJson(repo, name));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // /issues...
  if (head === 'issues') {
    return handleIssues(store, request, repo, tail.slice(1), body);
  }

  // /pulls...
  if (head === 'pulls') {
    return handlePulls(store, request, repo, tail.slice(1), body);
  }

  // GET /compare/{base}...{head}
  if (head === 'compare' && method === 'GET' && tail.length === 2) {
    const spec = tail[1] as string;
    const dots = spec.indexOf('...');
    if (dots < 0) return errorResponse(store, 404, 'Not Found');
    const baseRef = spec.slice(0, dots);
    const headRef = spec.slice(dots + 3);
    const baseTip = resolveRef(repo, baseRef);
    const headTip = resolveRef(repo, headRef);
    if (baseTip === undefined || headTip === undefined) return errorResponse(store, 404, 'Not Found');
    const mergeBase = store.mergeBase(repo, baseTip, headTip);
    const headReachable = new Set(store.reachableCommits(repo, [headTip]));
    const baseReachable = new Set(store.reachableCommits(repo, [baseTip]));
    const baseSet = mergeBase === null ? new Set<string>() : new Set(store.reachableCommits(repo, [mergeBase]));
    const ahead = [...headReachable].filter((oid) => !baseSet.has(oid)).length;
    const behind = [...baseReachable].filter((oid) => !baseSet.has(oid)).length;
    const status = ahead === 0 && behind === 0 ? 'identical' : ahead > 0 && behind === 0 ? 'ahead' : ahead === 0 && behind > 0 ? 'behind' : 'diverged';
    const files = store.diffFlat(repo, store.flatAt(repo, mergeBase), store.flatAt(repo, headTip));
    const commits = [...headReachable].filter((oid) => !baseSet.has(oid));
    // reachableCommits is newest-first; keep that order for the commit list.
    const orderedCommits = store.reachableCommits(repo, [headTip]).filter((oid) => commits.includes(oid));
    return jsonResponse(store, 200, {
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${spec}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/compare/${spec}`,
      permalink_url: `https://github.com/${repo.owner}/${repo.name}/compare/${spec}`,
      diff_url: `https://github.com/${repo.owner}/${repo.name}/compare/${spec}.diff`,
      patch_url: `https://github.com/${repo.owner}/${repo.name}/compare/${spec}.patch`,
      base_commit: commitJson(store, repo, baseTip),
      merge_base_commit: mergeBase === null ? null : commitJson(store, repo, mergeBase),
      status,
      ahead_by: ahead,
      behind_by: behind,
      total_commits: orderedCommits.length,
      commits: orderedCommits.map((oid) => commitJson(store, repo, oid)).filter((entry) => entry !== null),
      files: files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })),
    });
  }

  return errorResponse(store, 404, 'Not Found');
}

function branchJson(repo: RepoRec, branch: string): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? '';
  return {
    name: branch,
    commit: { sha: tip, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${tip}` },
    protected: false,
    protection_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${branch}/protection`,
  };
}

/** Resolve a branch name or a commit oid to a commit oid. */
function resolveRef(repo: RepoRec, ref: string): string | undefined {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) {
    const oid = repo.refs.get(`refs/tags/${ref}`) as string;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) return match[1];
    }
    return oid;
  }
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

// ---------------------------------------------------------------------------
// Git refs.
// ---------------------------------------------------------------------------

function handleGitRefs(store: Store, request: RestRequest, repo: RepoRec, tail: string[], body: unknown): RestResponse {
  const method = request.method;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  if (method === 'POST' && tail.length === 0) {
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/') || !isObjectId(sha)) {
      return errorResponse(store, 422, 'ref and sha are required');
    }
    if (repo.refs.has(ref)) return errorResponse(store, 422, 'Reference already exists');
    const object = repo.objects.get(sha);
    if (object === undefined) return errorResponse(store, 422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return jsonResponse(store, 201, { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), url: `${base}/git/refs/${ref.slice('refs/'.length)}`, object: { sha, type: object.type, url: `${base}/git/${object.type}s/${sha}` } });
  }

  if (tail.length >= 1) {
    const ref = `refs/${tail.join('/')}`;
    if (method === 'GET') {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorResponse(store, 404, 'Not Found');
      const object = repo.objects.get(oid);
      return jsonResponse(store, 200, {
        ref,
        node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
        url: `${base}/git/refs/${ref.slice('refs/'.length)}`,
        object: { sha: oid, type: object?.type ?? 'commit', url: `${base}/git/${object?.type ?? 'commit'}s/${oid}` },
      });
    }
    if (method === 'PATCH') {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorResponse(store, 404, 'Not Found');
      const sha = stringField(body, 'sha');
      const force = booleanField(body, 'force', false);
      if (!isObjectId(sha) || repo.objects.get(sha) === undefined) {
        return errorResponse(store, 422, 'Object does not exist');
      }
      if (!force && !store.isAncestor(repo, oid, sha) && oid !== sha) {
        return errorResponse(store, 422, 'Update is not a fast forward');
      }
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha);
      return jsonResponse(store, 200, {
        ref,
        node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
        url: `${base}/git/refs/${ref.slice('refs/'.length)}`,
        object: { sha, type: object?.type ?? 'commit', url: `${base}/git/${object?.type ?? 'commit'}s/${sha}` },
      });
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) return errorResponse(store, 404, 'Not Found');
      repo.refs.delete(ref);
      return noContentResponse(store);
    }
  }
  return errorResponse(store, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Contents.
// ---------------------------------------------------------------------------

function handleContents(store: Store, request: RestRequest, repo: RepoRec, tail: string[], body: unknown): RestResponse {
  const method = request.method;
  const path = tail.join('/');
  const branch = stringField(body, 'branch') || request.query.get('ref') || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? (isObjectId(branch) ? branch : undefined);

  if (method === 'GET') {
    const commit = tip === undefined ? null : store.commitOf(repo, tip);
    if (commit === null) return errorResponse(store, 404, 'Not Found');
    // Walk the tree to the requested path: a blob is a file, a tree a directory.
    let objectOid = commit.tree;
    let objectType: 'tree' | 'blob' = 'tree';
    if (path !== '') {
      const segments = path.split('/');
      let current = commit.tree;
      let found = true;
      for (const segment of segments) {
        const treeObject = repo.objects.get(current);
        if (treeObject === undefined || treeObject.type !== 'tree') {
          found = false;
          break;
        }
        const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
        if (entry === undefined) {
          found = false;
          break;
        }
        current = entry.oid;
        objectType = entry.mode === '40000' ? 'tree' : 'blob';
      }
      if (!found) return errorResponse(store, 404, 'Not Found');
      objectOid = current;
    }
    if (objectType === 'blob') {
      const blob = repo.objects.get(objectOid);
      const data = blob?.data ?? Buffer.alloc(0);
      return jsonResponse(store, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: objectOid,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${objectOid}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: null,
        _links: { git: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${objectOid}`, self: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`, html: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
      });
    }
    const treeObject = repo.objects.get(objectOid);
    if (treeObject === undefined || treeObject.type !== 'tree') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, treeEntries(repo, path, parseTree(treeObject.data)));
  }

  if (method === 'PUT') {
    if (path === '') return errorResponse(store, 422, 'a file path is required');
    const message = stringField(body, 'message');
    const contentBase64 = stringField(body, 'content');
    if (message === '' || contentBase64 === '') {
      return errorResponse(store, 422, 'message and content are required');
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, 'base64');
    } catch {
      return errorResponse(store, 422, 'content is not valid base64');
    }
    const flat = store.flatAt(repo, tip ?? null);
    const existing = flat.get(path);
    const givenSha = stringField(body, 'sha');
    if (existing !== undefined) {
      if (givenSha === '') return errorResponse(store, 422, 'sha is required when updating a file');
      if (givenSha !== existing) return errorResponse(store, 409, 'sha does not match the current file');
      const commitOid = store.contentsCommit(repo, branch, new Map([[path, content]]), message);
      const blobOid = hashObject('blob', content);
      return jsonResponse(store, 200, contentPutResponse(repo, path, blobOid, content, commitOid, message));
    }
    if (givenSha !== '') return errorResponse(store, 422, 'sha does not match: the file does not exist');
    const commitOid = store.contentsCommit(repo, branch, new Map([[path, content]]), message);
    const blobOid = hashObject('blob', content);
    return jsonResponse(store, 201, contentPutResponse(repo, path, blobOid, content, commitOid, message));
  }

  if (method === 'DELETE') {
    if (path === '') return errorResponse(store, 422, 'a file path is required');
    const message = stringField(body, 'message');
    const givenSha = stringField(body, 'sha');
    const flat = store.flatAt(repo, tip ?? null);
    const existing = flat.get(path);
    if (existing === undefined) return errorResponse(store, 404, 'Not Found');
    if (givenSha !== '' && givenSha !== existing) return errorResponse(store, 409, 'sha does not match the current file');
    const commitOid = store.contentsCommit(repo, branch, new Map([[path, null]]), message === '' ? `Delete ${path}` : message);
    return jsonResponse(store, 200, {
      content: null,
      commit: { sha: commitOid, message: message === '' ? `Delete ${path}` : message, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${commitOid}` },
    });
  }

  return errorResponse(store, 404, 'Not Found');
}

function contentPutResponse(repo: RepoRec, path: string, blobOid: string, content: Buffer, commitOid: string, message: string): Record<string, unknown> {
  return {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: null,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: {
      sha: commitOid,
      message,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${commitOid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${commitOid}`,
    },
  };
}

/** The entries of one tree object, as contents entries with real shas. */
function treeEntries(repo: RepoRec, dir: string, entries: Array<{ mode: string; name: string; oid: string }>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const childPath = dir === '' ? entry.name : `${dir}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
    out.push({
      type: isDir ? 'dir' : 'file',
      size,
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${childPath}`,
      _links: { git: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`, self: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${childPath}`, html: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}` },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issues.
// ---------------------------------------------------------------------------

function handleIssues(store: Store, request: RestRequest, repo: RepoRec, tail: string[], body: unknown): RestResponse {
  const method = request.method;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // GET /issues, POST /issues
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const direction = request.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, link } = paginate(request, issues, `${base}/issues`);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return jsonResponse(store, 200, page.map((issue) => issueJson(repo, issue)), headers);
    }
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (title === '') return errorResponse(store, 422, 'title is required');
      const bodyText = stringField(body, 'body');
      const labelNames = labelNamesFrom(body, 'labels');
      const unknown = labelNames.find((name) => !repo.labels.has(name));
      if (unknown !== undefined) return errorResponse(store, 422, `Label does not exist: ${unknown}`);
      const issue = createIssueInStore(store, repo, title, bodyText, labelNames);
      return jsonResponse(store, 201, issueJson(repo, issue));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  const number = parseInt(tail[0] as string, 10);
  if (!Number.isFinite(number)) return errorResponse(store, 404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return errorResponse(store, 404, 'Not Found');

  // GET /issues/{n}, PATCH /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(store, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (body.labels !== undefined) {
          const labelNames = labelNamesFrom(body, 'labels');
          const unknown = labelNames.find((name) => !repo.labels.has(name));
          if (unknown !== undefined) return errorResponse(store, 422, `Label does not exist: ${unknown}`);
          issue.labels = labelNames;
        }
      }
      return jsonResponse(store, 200, issueJson(repo, issue));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const comments = issue.comments.map((comment) => ({
        id: repo.id * 1000000 + comment.id,
        node_id: comment.globalId,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        body: comment.body,
        user: viewerJson(),
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        author_association: 'OWNER',
      }));
      return jsonResponse(store, 200, comments);
    }
    if (method === 'POST') {
      const commentBody = stringField(body, 'body');
      if (commentBody === '') return errorResponse(store, 422, 'body is required');
      const id = repo.nextComment++;
      const comment = { id, body: commentBody, globalId: globalId('IssueComment', `${repo.id}:${issue.number}:${id}`) };
      issue.comments.push(comment);
      return jsonResponse(store, 201, {
        id: repo.id * 1000000 + id,
        node_id: comment.globalId,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${id}`,
        body: commentBody,
        user: viewerJson(),
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        author_association: 'OWNER',
      });
    }
    return errorResponse(store, 404, 'Not Found');
  }

  return errorResponse(store, 404, 'Not Found');
}

/** Labels from a request body: an array of names or of {name} objects. */
function labelNamesFrom(body: unknown, field: string): string[] {
  if (!isRecord(body)) return [];
  const value = body[field];
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Pull requests.
// ---------------------------------------------------------------------------

function handlePulls(store: Store, request: RestRequest, repo: RepoRec, tail: string[], body: unknown): RestResponse {
  const method = request.method;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // GET /pulls, POST /pulls
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(request, pulls, `${base}/pulls`);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return jsonResponse(store, 200, page.map((pull) => pullJson(store, repo, pull)), headers);
    }
    if (method === 'POST') {
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const baseRef = stringField(body, 'base');
      if (title === '' || head === '' || baseRef === '') {
        return errorResponse(store, 422, 'title, head and base are required');
      }
      const created = createPullInStore(store, repo, title, stringField(body, 'body'), head, baseRef);
      if ('error' in created) return errorResponse(store, 422, created.error);
      return jsonResponse(store, 201, pullJson(store, repo, created));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  const number = parseInt(tail[0] as string, 10);
  if (!Number.isFinite(number)) return errorResponse(store, 404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return errorResponse(store, 404, 'Not Found');

  // GET /pulls/{n}, PATCH /pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(store, 200, pullJson(store, repo, pull));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      }
      return jsonResponse(store, 200, pullJson(store, repo, pull));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const mergeBase = store.mergeBase(repo, baseTip, headTip);
    const files = store.diffFlat(repo, store.flatAt(repo, mergeBase), store.flatAt(repo, headTip));
    return jsonResponse(
      store,
      200,
      files.map((file) => ({
        sha: '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${headTip}/${file.filename}`,
        raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${headTip}/${file.filename}`,
        contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${headTip}`,
      })),
    );
  }

  // GET /pulls/{n}/commits
  if (tail.length === 2 && tail[1] === 'commits' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const mergeBase = store.mergeBase(repo, baseTip, headTip);
    const commits = store.reachableCommits(repo, [headTip]).filter((oid) => {
      if (mergeBase === null) return true;
      return !store.reachableCommits(repo, [mergeBase]).includes(oid);
    });
    return jsonResponse(
      store,
      200,
      commits.map((oid) => commitJson(store, repo, oid)).filter((entry) => entry !== null),
    );
  }

  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return errorResponse(store, 405, 'Pull request has already been merged');
    if (pull.state !== 'open') return errorResponse(store, 405, 'Pull request is closed');
    const merged = store.squashMerge(repo, pull);
    if (merged === null) return errorResponse(store, 405, 'Pull request is not mergeable');
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = NOW_ISO;
    pull.mergeCommitSha = merged;
    return jsonResponse(store, 200, { sha: merged, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` });
  }

  return errorResponse(store, 404, 'Not Found');
}
