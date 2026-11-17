// store.ts — the forge's in-memory store: the scenario's users, the git object model
// (hashing, trees, commits, packs, pkt-lines) and every repository, issue, label,
// comment and pull request the four surfaces share. One store, four surfaces.
//
// Determinism is a design rule here, not an afterthought: no wall clock, no
// Math.random, no timestamps from the machine. Server-built commits carry a fixed
// identity and a fixed epoch, request ids come from a counter, and every id the
// store hands out is a counter or a hash of stable bytes. A trial's live run and
// its replay therefore see the same answers.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync, type Zlib } from 'node:zlib';

// ---------------------------------------------------------------------------
// The scenario's users, derived from the contest's one fixed seed.
//
// The env builds its scenario from SCENARIO_SEED with a small xorshift64* stream
// (wire.ts: fnv1a64, mix64, scenarioSeedFor, Rng, generateUsers). The token the
// env hands out belongs to the scenario's viewer, and the checks address
// repositories by that login, so the forge must know it. Porting the generator
// (same seed, same stream, same name lists) gives the same logins the env
// computes, without ever reading the kit at run time.
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`;
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

function scenarioOrg(): string {
  const rng = new Rng(scenarioSeedFor('org'));
  return `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}-org`;
}

export const SCENARIO_USERS: ScenarioUser[] = generateUsers(12);
export const VIEWER_LOGIN: string = SCENARIO_USERS[0]?.login ?? 'adaiversen';
export const VIEWER_USER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
export const STRANGER_LOGIN: string = SCENARIO_USERS[2]?.login ?? 'olgabauer';
export const SCENARIO_ORG: string = scenarioOrg();
export const DEFAULT_BRANCH = 'main';

// Fixed identity and epoch for every commit the server builds itself (contents
// commits, squash merges). The checks never read these fields, and a constant
// keeps live and replay byte-identical.
export const SERVER_IDENTITY = { name: 'Forge', email: 'forge@make.fun' };
export const SERVER_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch.
export const NOW_ISO = '2025-01-01T00:00:00Z';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const SHA1_RE = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return SHA1_RE.test(value);
}

// ---------------------------------------------------------------------------
// Git objects.
// ---------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  // Incremental hash: the same digest as hashing header+data, without
  // copying the (possibly large) data into a throwaway buffer first.
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number };
  committer: { name: string; email: string; timestamp: number };
  message: string;
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author.name} <${parts.author.email}> ${parts.author.timestamp} +0000`);
  lines.push(`committer ${parts.committer.name} <${parts.committer.email}> ${parts.committer.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, message, authorLine, committerLine };
}

export interface Identity {
  name: string;
  email: string;
  timestamp: number;
}

/** Parse an identity line (`Name <email> <unix seconds> +0000`). */
export function parseIdentity(line: string): Identity {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1] as string, email: match[2] as string, timestamp: parseInt(match[3] as string, 10) };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Sort key git uses inside a tree: directories sort as if their name had a trailing slash. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A flat path -> blob-oid map, from a tree object. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/**
 * Build (and store) the trees for a flat path -> blob-oid map, bottom-up.
 * Returns the root tree oid. `put` stores every object it creates.
 */
export function buildTreesFromFlat(flat: Map<string, string>, put: (type: ObjectType, data: Buffer) => string): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// Packs: plain objects only, no deltas (the client never sends deltas either).
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const typeNum = PACK_TYPES[type] as number;
  const bytes: number[] = [];
  let remaining = size;
  bytes.push((typeNum << 4) | (remaining & 0x0f));
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  // The continuation bit belongs on every byte but the last: the bytes were
  // pushed with it set, so clear it on the last byte only.
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) & 0x7f;
  if (bytes.length > 1) bytes[0] = (bytes[0] as number) | 0x80;
  return Buffer.from(bytes);
}

export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const trailer = sha1Hex(Buffer.concat(parts));
  parts.push(Buffer.from(trailer, 'hex'));
  return Buffer.concat(parts);
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
}

/**
 * Inflate exactly one zlib stream starting at `offset`, synchronously.
 * inflateSync with `info: true` reports the engine's bytesWritten — the input
 * bytes the stream consumed — which is the stream's exact length, so the next
 * entry starts right after it. (The previous version created a streaming
 * Inflater per object; each one cost an event-loop turn per object, which is
 * what a receive-pack pays per pushed object.)
 */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  // @types/node does not declare the info overload's { buffer, engine }
  // return shape, so cast: at runtime inflateSync with info:true returns
  // exactly that (verified: engine.bytesWritten is the stream's length).
  const { buffer, engine } = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: Zlib;
  };
  return { data: buffer, consumed: engine.bytesWritten };
}

/** Read a pack of plain objects. Throws on a bad checksum, a delta entry, or truncation. */
export async function readPack(pack: Buffer): Promise<PackReadResult> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    if (offset >= pack.length - 20) throw new Error('pack is truncated');
    let byte = pack[offset] as number;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6 || typeNum === 7) throw new Error('delta pack entries are not supported');
    const type = PACK_TYPE_NAMES[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    const { data, consumed } = inflateOne(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
    objects.set(hashObject(type, data), { type, data });
  }
  return { version, declaredCount, objects };
}

// ---------------------------------------------------------------------------
// pkt-lines and sideband.
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first byte sequence
 * that is not a pkt-line (the raw pack bytes after a receive-pack flush, for
 * example) and returns the packets plus the offset where the pkt-line stream
 * ends. A length that overruns the buffer also ends the stream.
 */
export function decodePktLines(buf: Buffer, start = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const lengthText = buf.subarray(offset, offset + 4).toString('ascii');
    if (lengthText === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lengthText === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = parseInt(lengthText, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buf.length) {
      break;
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, end: offset };
}

/** Split bytes into sideband band-1 pkt-lines (each payload ≤ 65519 bytes). */
export function sidebandData(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65519;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export interface CommentRec {
  id: number;
  body: string;
  globalId: string;
}

export interface IssueRec {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: IssueRec[];
  /** The next shared number for issues and pull requests (GitHub numbers them together). */
  nextNumber: number;
  labels: Map<string, { name: string; color: string }>;
  pulls: PullRec[];
  nextComment: number;
  commitSeq: Map<string, number>;
  nextCommitSeq: number;
}

export function globalId(kind: string, parts: string): string {
  return `${kind}_${Buffer.from(parts, 'utf8').toString('base64url')}`;
}

export function decodeGlobalId(id: string): { kind: string; parts: string } | null {
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  const kind = id.slice(0, underscore);
  try {
    const parts = Buffer.from(id.slice(underscore + 1), 'base64url').toString('utf8');
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split text into lines: 'a\n' is one line, '' is none. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** A small line diff: LCS over lines, good enough for the kilobyte files here. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths, two rows.
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  const common = prev[n] as number;
  return { additions: n - common, deletions: m - common };
}

function isText(data: Buffer): boolean {
  // A NUL byte in the first kilobyte means binary for our purposes.
  const sample = data.subarray(0, Math.min(1024, data.length));
  return !sample.includes(0);
}

export class Store {
  repos = new Map<string, RepoRec>();
  repoOrder: RepoRec[] = [];
  nextRepoId = 5000;
  nextRepoSeq = 1;
  nextRequestId = 1;
  nextCommitSeqGlobal = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nextRequest(): string {
    return `req-${this.nextRequestId++}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextRepoSeq++,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextNumber: 1,
      labels: new Map(),
      pulls: [],
      nextComment: 1,
      commitSeq: new Map(),
      nextCommitSeq: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    this.repoOrder = this.repoOrder.filter((entry) => entry !== repo);
    return true;
  }

  reposOf(owner: string): RepoRec[] {
    return this.repoOrder.filter((repo) => repo.owner === owner);
  }

  putObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        repo.commitSeq.set(oid, this.nextCommitSeqGlobal++);
      }
    }
    return oid;
  }

  /** The commit object for an oid, or null. */
  commitOf(repo: RepoRec, oid: string): ParsedCommit | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Every commit reachable from `roots` (parents followed), newest first by store order. */
  reachableCommits(repo: RepoRec, roots: string[]): string[] {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      for (const parent of commit.parents) stack.push(parent);
    }
    return [...seen].sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  }

  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const ancestorsA = new Set(this.reachableCommits(repo, [a]));
    const candidates = this.reachableCommits(repo, [b]).filter((oid) => ancestorsA.has(oid));
    if (candidates.length === 0) return null;
    // reachableCommits is newest-first, so the first common commit is the best base.
    return candidates[0] as string;
  }

  /**
   * The objects a fetch of `wants` must deliver, honouring `haves` (already held)
   * and an optional `depth` (shallow boundary). Returns the pack objects plus
   * the new shallow boundary commits and the old boundaries now unshallowed.
   */
  fetchSet(
    repo: RepoRec,
    wants: string[],
    haves: string[],
    depth: number | null,
    oldShallow: string[],
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const held = new Set<string>();
    // What the client already holds: the closure of its haves, cut at its
    // shallow boundaries — a shallow client holds a boundary commit's tree
    // but not the boundary's parents, so those must still be sent.
    const boundarySet = new Set(oldShallow);
    for (const have of haves) {
      for (const oid of this.reachableObjects(repo, [have], { boundary: boundarySet }).keys()) held.add(oid);
    }
    const wanted = new Map<string, GitObject>();
    const boundary = new Set<string>();
    if (depth !== null) {
      // Walk commits by distance from the wants; commits at distance depth-1
      // are the new shallow boundary (included, with their trees).
      // An index pointer, not shift(): the queue is walked once, in order.
      const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
      const seenCommit = new Set<string>();
      const includedCommits: string[] = [];
      for (let qi = 0; qi < queue.length; qi += 1) {
        const { oid, distance } = queue[qi] as { oid: string; distance: number };
        if (seenCommit.has(oid)) continue;
        seenCommit.add(oid);
        const commit = this.commitOf(repo, oid);
        if (commit === null) {
          // A want may be a tag or a tree/blob: include it whole.
          const object = repo.objects.get(oid);
          if (object !== undefined) wanted.set(oid, object);
          continue;
        }
        if (distance >= depth) continue;
        includedCommits.push(oid);
        if (distance === depth - 1) boundary.add(oid);
        for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
      }
      for (const oid of includedCommits) {
        const commit = this.commitOf(repo, oid);
        if (commit === null) continue;
        const closure = this.reachableObjects(repo, [oid], { stopAtCommits: true });
        for (const [objectOid, object] of closure) wanted.set(objectOid, object);
      }
      // A boundary commit's tree is part of its closure already (stopAtCommits keeps
      // the commit's own tree but not its parents' trees).
    } else {
      for (const [oid, object] of this.reachableObjects(repo, wants)) wanted.set(oid, object);
    }
    for (const oid of held) wanted.delete(oid);
    // An old boundary is unshallowed when it (or one of its parents) is in
    // the pack: its history is no longer cut off.
    const unshallow = oldShallow.filter((oid) => {
      if (wanted.has(oid)) return true;
      const commit = this.commitOf(repo, oid);
      return commit !== null && commit.parents.some((parent) => wanted.has(parent));
    });
    return { objects: wanted, shallow: [...boundary], unshallow };
  }

  /**
   * Every object reachable from `roots`: commits, their trees and blobs, tags
   * and their targets. With `stopAtCommits`, a commit's own tree is included
   * but its parents are not followed (used for shallow fetches). With
   * `boundary`, the walk stops at those commits (their trees are included,
   * their parents are not): a shallow client's boundary commits are held
   * without their history.
   */
  reachableObjects(
    repo: RepoRec,
    roots: string[],
    options: { stopAtCommits?: boolean; boundary?: Set<string> } = {},
  ): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack = [...roots];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        const tree = repo.objects.get(commit.tree);
        if (tree !== undefined) stack.push(commit.tree);
        const isBoundary = options.boundary?.has(oid) ?? false;
        if (options.stopAtCommits !== true && !isBoundary) {
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match !== null) stack.push(match[1] as string);
      }
    }
    return out;
  }

  /** Flat path -> blob oid map at a commit, or an empty map when there is none. */
  flatAt(repo: RepoRec, commitOid: string | null): Map<string, string> {
    if (commitOid === null) return new Map();
    const commit = this.commitOf(repo, commitOid);
    if (commit === null) return new Map();
    return flattenTree(repo.objects, commit.tree);
  }

  /** Diff two flat maps into the pull-request files shape. */
  diffFlat(repo: RepoRec, base: Map<string, string>, head: Map<string, string>): DiffFile[] {
    const files: DiffFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = base.get(path);
      const headOid = head.get(path);
      if (baseOid === headOid) continue;
      if (baseOid === undefined && headOid !== undefined) {
        const blob = repo.objects.get(headOid);
        const text = blob !== undefined && isText(blob.data) ? blob.data.toString('utf8') : '';
        const lines = splitLines(text).length;
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (headOid === undefined && baseOid !== undefined) {
        const blob = repo.objects.get(baseOid);
        const text = blob !== undefined && isText(blob.data) ? blob.data.toString('utf8') : '';
        const lines = splitLines(text).length;
        files.push({ filename: path, status: 'deleted', additions: 0, deletions: lines, changes: lines });
      } else if (baseOid !== undefined && headOid !== undefined) {
        const oldBlob = repo.objects.get(baseOid);
        const newBlob = repo.objects.get(headOid);
        let additions = 1;
        let deletions = 1;
        if (oldBlob !== undefined && newBlob !== undefined && isText(oldBlob.data) && isText(newBlob.data)) {
          const counts = lineDiffCounts(oldBlob.data.toString('utf8'), newBlob.data.toString('utf8'));
          additions = counts.additions;
          deletions = counts.deletions;
        }
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** Would merging `headTip` into `baseTip` conflict? (A changed path whose base version moved.) */
  mergeConflicts(repo: RepoRec, baseTip: string, headTip: string): boolean {
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return false;
    const baseFlat = this.flatAt(repo, base);
    const baseTipFlat = this.flatAt(repo, baseTip);
    const headFlat = this.flatAt(repo, headTip);
    const changed = this.diffFlat(repo, baseFlat, headFlat);
    for (const file of changed) {
      const atBase = baseFlat.get(file.filename);
      const atBaseTip = baseTipFlat.get(file.filename);
      if (atBase !== atBaseTip) return true;
    }
    return false;
  }

  /** The mergeable state for a pull request, in GraphQL's spelling. */
  mergeableOf(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch carrying the
   * head's changed paths, parents [base tip]. Returns the merge commit oid,
   * or null when the merge conflicts.
   */
  squashMerge(repo: RepoRec, pull: PullRec): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return null;
    if (this.mergeConflicts(repo, baseTip, headTip)) return null;
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseFlat = this.flatAt(repo, base);
    const headFlat = this.flatAt(repo, headTip);
    const merged = this.flatAt(repo, baseTip);
    const changed = this.diffFlat(repo, baseFlat, headFlat);
    for (const file of changed) {
      const headOid = headFlat.get(file.filename);
      if (headOid === undefined) merged.delete(file.filename);
      else merged.set(file.filename, headOid);
    }
    const treeOid = buildTreesFromFlat(merged, (type, data) => this.putObject(repo, type, data));
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: { ...SERVER_IDENTITY, timestamp: SERVER_EPOCH_SEC },
      committer: { ...SERVER_IDENTITY, timestamp: SERVER_EPOCH_SEC },
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    return commitOid;
  }

  /**
   * Commit one contents change on a branch: `changes` maps a path to new
   * bytes (null deletes the path). Creates the branch from the default tip
   * when it does not exist yet. Returns the new commit oid.
   */
  contentsCommit(
    repo: RepoRec,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): string {
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const flat = this.flatAt(repo, tip ?? null);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, this.putObject(repo, 'blob', content));
    }
    const treeOid = buildTreesFromFlat(flat, (type, data) => this.putObject(repo, type, data));
    const parents = tip === undefined ? [] : [tip];
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: { ...SERVER_IDENTITY, timestamp: SERVER_EPOCH_SEC },
      committer: { ...SERVER_IDENTITY, timestamp: SERVER_EPOCH_SEC },
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }
}
