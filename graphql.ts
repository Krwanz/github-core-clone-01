// graphql.ts — the GraphQL v4 surface at POST /api/graphql.
//
// A small, purpose-built executor for the documents the suite sends (gh's
// queries and mutations): viewer, repository (+ issues/pullRequests with
// cursors), node(id:), createIssue/closeIssue/createPullRequest/
// mergePullRequest/addComment, and __type introspection. It parses each
// document, substitutes the variables, resolves against the shared store and
// answers in order. An unknown field is a 200 with an errors array naming it,
// never an HTTP 400. A batch (an array body) answers an array in order.

import {
  NOW_ISO,
  SCENARIO_USERS,
  VIEWER_USER,
  decodeGlobalId,
  globalId,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';
import { createIssueInStore, createPullInStore, isAuthorized, type RestRequest, type RestResponse } from './rest.ts';

// ---------------------------------------------------------------------------
// The schema the introspection probes describe.
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt',
  'author', 'labels', 'comments', 'repository', 'url',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
  'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'mergedAt', 'repository', 'url',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'url',
];
const USER_FIELDS = ['id', 'login', 'name', 'email'];
const SEARCH_TYPE_VALUES = [
  'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE',
  'MILESTONE', 'PROJECT', 'WIKI',
];

function typeFields(name: string): string[] | null {
  switch (name) {
    case 'Issue':
      return ISSUE_FIELDS;
    case 'PullRequest':
      return PULL_REQUEST_FIELDS;
    case 'Repository':
      return REPOSITORY_FIELDS;
    case 'User':
      return USER_FIELDS;
    default:
      return null;
  }
}

function typeKind(name: string): string | null {
  if (name === 'SearchType') return 'ENUM';
  return typeFields(name) === null ? null : 'OBJECT';
}

// ---------------------------------------------------------------------------
// A minimal GraphQL document parser (the subset the suite sends).
// ---------------------------------------------------------------------------

type GqlValue = null | boolean | number | string | GqlValue[] | { [key: string]: GqlValue } | { __variable: string };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          text += source[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(text));
      i = j + 1;
      continue;
    }
    if (char === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(char) || char === '-') {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_.!-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (char === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    tokens.push(char);
    i += 1;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') {
        name = this.next();
      }
    }
    if (this.peek() === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      throw new Error('named fragment spreads are not supported');
    }
    const first = this.next();
    let alias = first;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      name = this.next();
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek() === '(') args = this.parseArguments();
    let selections: Selection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): Record<string, GqlValue> {
    this.expect('(');
    const args: Record<string, GqlValue> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.startsWith('$')) return { __variable: token.slice(1) };
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return items;
    }
    if (token === '{') {
      const object: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    const number = Number(token);
    if (token !== '' && Number.isFinite(number) && /^-?\d+(\.\d+)?$/.test(token)) return number;
    return token;
  }
}

/** Substitute $variables in a parsed value. */
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__variable' in value) {
    return (value as { __variable: string }).__variable in variables ? variables[(value as { __variable: string }).__variable] : null;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Nodes: every resolved value carries its __typename (stripped on output).
// ---------------------------------------------------------------------------

interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

function userNode(login: string): GqlNode {
  const user = SCENARIO_USERS.find((candidate) => candidate.login === login);
  return {
    __typename: 'User',
    id: globalId('User', String(user?.id ?? VIEWER_USER.id)),
    login,
    name: user?.name ?? login,
    email: user?.email ?? `${login}@example.invalid`,
  };
}

function repoNode(repo: RepoRec): GqlNode {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(repo.owner),
    defaultBranchRef: tip === undefined ? null : { __typename: 'Branch', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    isPrivate: repo.isPrivate,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    __repo: repo,
  };
}

function issueNode(repo: RepoRec, issue: IssueRec): GqlNode {
  return {
    __typename: 'Issue',
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    closedAt: issue.state === 'closed' ? NOW_ISO : null,
    author: userNode(VIEWER_USER.login),
    repository: repoNode(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    __repo: repo,
    __issue: issue,
  };
}

function pullNode(store: Store, repo: RepoRec, pull: PullRec): GqlNode {
  return {
    __typename: 'PullRequest',
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: store.mergeableOf(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Branch', name: pull.headRef },
    baseRef: { __typename: 'Branch', name: pull.baseRef },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    closedAt: pull.state === 'closed' ? NOW_ISO : null,
    mergedAt: pull.mergedAt,
    author: userNode(VIEWER_USER.login),
    repository: repoNode(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    __repo: repo,
    __pull: pull,
  };
}

function commentNode(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; globalId: string }): GqlNode {
  return {
    __typename: 'IssueComment',
    id: comment.globalId,
    body: comment.body,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    author: userNode(VIEWER_USER.login),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    __repo: repo,
    __issue: issue,
    __comment: comment,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

function connection<T>(items: T[], args: Record<string, unknown>, toNode: (item: T) => GqlNode, typeName: string): GqlNode {
  const first = typeof args.first === 'number' ? args.first : null;
  const afterIndex = indexFromCursor(args.after);
  const start = afterIndex + 1;
  const slice = first === null ? items.slice(start) : items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  const hasNextPage = start + slice.length < items.length;
  return {
    __typename: typeName,
    nodes: slice.map((item) => toNode(item)),
    edges: slice.map((item, offset) => ({ __typename: `${typeName}Edge`, node: toNode(item), cursor: cursorFor(start + offset) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(endIndex) : null,
    },
    totalCount: items.length,
  };
}

function issuesConnection(store: Store, repo: RepoRec, args: Record<string, unknown>): GqlNode {
  let issues = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return connection(issues, args, (issue) => issueNode(repo, issue), 'IssueConnection');
}

function pullsConnection(store: Store, repo: RepoRec, args: Record<string, unknown>): GqlNode {
  let pulls = [...repo.pulls];
  const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return connection(pulls, args, (pull) => pullNode(store, repo, pull), 'PullRequestConnection');
}

function filesConnection(store: Store, repo: RepoRec, pull: PullRec, args: Record<string, unknown>): GqlNode {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeBase = store.mergeBase(repo, baseTip, headTip);
  const files = store.diffFlat(repo, store.flatAt(repo, mergeBase), store.flatAt(repo, headTip));
  return connection(
    files,
    args,
    (file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
    'PullRequestFileConnection',
  );
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldError(executor: Executor, typeName: string, fieldName: string): null {
  executor.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function executeSelections(executor: Executor, node: GqlNode | null, selections: Selection[]): Record<string, unknown> | null {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== node.__typename) continue;
      const merged = executeSelections(executor, node, selection.selections);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    out[selection.alias] = executeField(executor, node, selection);
  }
  return out;
}

function executeField(executor: Executor, parent: GqlNode, field: FieldSelection): unknown {
  const args = resolveArgs(field.args, executor.variables);
  const value = resolveField(executor, parent, field.name, args);
  if (value === undefined) return fieldError(executor, parent.__typename, field.name);
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)) {
        return executeSelections(executor, entry as GqlNode, field.selections);
      }
      return entry;
    });
  }
  if ('__typename' in (value as Record<string, unknown>)) {
    return executeSelections(executor, value as GqlNode, field.selections);
  }
  return value;
}

function resolveField(executor: Executor, parent: GqlNode, name: string, args: Record<string, unknown>): unknown {
  const store = executor.store;
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return userNode(VIEWER_USER.login);
      if (name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === 'node') {
        return nodeById(store, String(args.id ?? ''));
      }
      if (name === '__type') {
        return introspectionType(String(args.name ?? ''));
      }
      if (name === '__schema') {
        return { __typename: '__Schema', types: [] };
      }
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') return mutationCreateIssue(executor, args);
      if (name === 'closeIssue') return mutationCloseIssue(executor, args);
      if (name === 'createPullRequest') return mutationCreatePullRequest(executor, args);
      if (name === 'mergePullRequest') return mutationMergePullRequest(executor, args);
      if (name === 'addComment') return mutationAddComment(executor, args);
      return undefined;
    }
    case 'Repository': {
      const repo = parent.__repo as RepoRec;
      switch (name) {
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === args.number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issuesConnection(store, repo, args);
        case 'pullRequests':
          return pullsConnection(store, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === args.number);
          return pull === undefined ? null : pullNode(store, repo, pull);
        }
        default: {
          const value = (parent as Record<string, unknown>)[name];
          return value === undefined ? undefined : value;
        }
      }
    }
    case 'PullRequest': {
      if (name === 'files') {
        const pull = parent.__pull as PullRec;
        const repo = parent.__repo as RepoRec;
        return filesConnection(store, repo, pull, args);
      }
      const value = (parent as Record<string, unknown>)[name];
      return value === undefined ? undefined : value;
    }
    case 'Issue': {
      if (name === 'comments') {
        const issue = parent.__issue as IssueRec;
        const repo = parent.__repo as RepoRec;
        return connection(issue.comments, args, (comment) => commentNode(repo, issue, comment), 'IssueCommentConnection');
      }
      const value = (parent as Record<string, unknown>)[name];
      return value === undefined ? undefined : value;
    }
    default: {
      const value = (parent as Record<string, unknown>)[name];
      return value === undefined ? undefined : value;
    }
  }
}

function introspectionType(name: string): GqlNode | null {
  const kind = typeKind(name);
  if (kind === null) return null;
  const fields = typeFields(name);
  if (kind === 'ENUM') {
    return {
      __typename: '__Type',
      kind,
      name,
      description: null,
      fields: null,
      enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })),
    };
  }
  return {
    __typename: '__Type',
    kind,
    name,
    description: null,
    fields: (fields ?? []).map((fieldName) => ({
      __typename: '__Field',
      name: fieldName,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
      args: [],
      type: { __typename: '__Type', kind: 'SCALAR', name: 'String', description: null },
    })),
    enumValues: null,
  };
}

function nodeById(store: Store, id: string): GqlNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const parts = decoded.parts.split(':');
  if (decoded.kind === 'Repository') {
    const repoId = parseInt(parts[0] as string, 10);
    const repo = store.repoOrder.find((entry) => entry.id === repoId);
    return repo === undefined ? null : repoNode(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repoId = parseInt(parts[0] as string, 10);
    const number = parseInt(parts[1] as string, 10);
    const repo = store.repoOrder.find((entry) => entry.id === repoId);
    if (repo === undefined) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull === undefined ? null : pullNode(store, repo, pull);
  }
  if (decoded.kind === 'IssueComment') {
    const repoId = parseInt(parts[0] as string, 10);
    const issueNumber = parseInt(parts[1] as string, 10);
    const commentId = parseInt(parts[2] as string, 10);
    const repo = store.repoOrder.find((entry) => entry.id === repoId);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === issueNumber);
    if (issue === undefined) return null;
    const comment = issue.comments.find((entry) => entry.id === commentId);
    return comment === undefined ? null : commentNode(repo, issue, comment);
  }
  return null;
}

function repoByGlobalId(store: Store, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = parseInt(decoded.parts, 10);
  return store.repoOrder.find((entry) => entry.id === repoId) ?? null;
}

function mutationCreateIssue(executor: Executor, args: Record<string, unknown>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoByGlobalId(executor.store, input.repositoryId);
  if (repo === null) {
    executor.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') {
    executor.errors.push({ message: 'title is required.' });
    return null;
  }
  const issue = createIssueInStore(executor.store, repo, title, typeof input.body === 'string' ? input.body : '', []);
  return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
}

function mutationCloseIssue(executor: Executor, args: Record<string, unknown>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = nodeById(executor.store, String(input.issueId ?? ''));
  if (node === null || node.__typename !== 'Issue') {
    executor.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  const issue = node.__issue as IssueRec;
  const repo = node.__repo as RepoRec;
  issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
}

function mutationCreatePullRequest(executor: Executor, args: Record<string, unknown>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoByGlobalId(executor.store, input.repositoryId);
  if (repo === null) {
    executor.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
    return null;
  }
  const created = createPullInStore(
    executor.store,
    repo,
    typeof input.title === 'string' ? input.title : '',
    typeof input.body === 'string' ? input.body : '',
    typeof input.headRefName === 'string' ? input.headRefName : '',
    typeof input.baseRefName === 'string' ? input.baseRefName : '',
  );
  if ('error' in created) {
    executor.errors.push({ message: created.error });
    return null;
  }
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(executor.store, repo, created) };
}

function mutationMergePullRequest(executor: Executor, args: Record<string, unknown>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = nodeById(executor.store, String(input.pullRequestId ?? ''));
  if (node === null || node.__typename !== 'PullRequest') {
    executor.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
    return null;
  }
  const pull = node.__pull as PullRec;
  const repo = node.__repo as RepoRec;
  if (pull.merged) {
    executor.errors.push({ message: 'Pull request has already been merged.' });
    return null;
  }
  if (pull.state !== 'open') {
    executor.errors.push({ message: 'Pull request is closed.' });
    return null;
  }
  const merged = executor.store.squashMerge(repo, pull);
  if (merged === null) {
    executor.errors.push({ message: 'Pull request is not mergeable.' });
    return null;
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = NOW_ISO;
  pull.mergeCommitSha = merged;
  return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(executor.store, repo, pull) };
}

function mutationAddComment(executor: Executor, args: Record<string, unknown>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = nodeById(executor.store, String(input.subjectId ?? ''));
  if (node === null || node.__typename !== 'Issue') {
    executor.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  const issue = node.__issue as IssueRec;
  const repo = node.__repo as RepoRec;
  const body = typeof input.body === 'string' ? input.body : '';
  const id = repo.nextComment++;
  const comment = { id, body, globalId: globalId('IssueComment', `${repo.id}:${issue.number}:${id}`) };
  issue.comments.push(comment);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(repo, issue, comment), cursor: cursorFor(issue.comments.length - 1) },
  };
}

// ---------------------------------------------------------------------------
// HTTP entry point.
// ---------------------------------------------------------------------------

interface GraphQLOperationBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const executor: Executor = { store, variables, errors: [] };
  const root: GqlNode = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(executor, root, operation.selections);
  const response: Record<string, unknown> = { data };
  if (executor.errors.length > 0) response.errors = executor.errors;
  return response;
}

function runBody(store: Store, body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((entry) => runOne(store, entry));
  }
  return runOne(store, body);
}

function runOne(store: Store, entry: unknown): Record<string, unknown> {
  const operation = (entry ?? {}) as GraphQLOperationBody;
  if (typeof operation.query !== 'string' || operation.query.trim() === '') {
    return { data: null, errors: [{ message: 'A query is required.' }] };
  }
  const variables = (operation.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(operation.query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Could not parse the query.' }] };
  }
  const selected = typeof operation.operationName === 'string' ? operations.find((candidate) => candidate.name === operation.operationName) : operations[0];
  if (selected === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${String(operation.operationName)}".` }] };
  }
  return executeOperation(store, selected, variables);
}

export function handleGraphQL(store: Store, request: RestRequest): RestResponse {
  if (!isAuthorized(request)) {
    return { status: 401, headers: { 'content-type': 'application/json', 'x-github-request-id': store.nextRequest() }, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
  }
  let body: unknown;
  try {
    body = JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, headers: { 'content-type': 'application/json', 'x-github-request-id': store.nextRequest() }, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Request body is not valid JSON.' }] }), 'utf8') };
  }
  const result = runBody(store, body);
  return { status: 200, headers: { 'content-type': 'application/json', 'x-github-request-id': store.nextRequest() }, body: Buffer.from(JSON.stringify(result), 'utf8') };
}
