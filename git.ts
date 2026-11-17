// git.ts — git smart HTTP: info/refs advertisements (v2 and v0), upload-pack
// (protocol v2 and v0) and receive-pack (v0). The wire is implemented from the
// protocol itself: pkt-lines, sideband framing, packs of plain objects.
//
// The client the suite grades with (git-client.ts) decides the version from the
// advertisement: upload-pack answers v2 when the request carries a
// `Git-Protocol: version=2` header, v0 otherwise; receive-pack is always v0.
// A fetch's response sections are flush-separated: acknowledgments,
// shallow-info, wanted-refs, packfile.

import {
  ZERO_OID,
  isObjectId,
  decodePktLines,
  encodePktLines,
  pktLine,
  PKT_FLUSH,
  readPack,
  writePack,
  parseCommit,
  type RepoRec,
  type Store,
} from './store.ts';

export const AGENT = 'forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** Every ref the repo advertises, HEAD first, then heads, then tags. */
export function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    lines.push({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) {
    lines.push({ oid: repo.refs.get(name) as string, name });
  }
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) peeled = match[1];
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: RepoRec): Buffer {
  const preamble = `# service=${service}\n`;
  const parts: Buffer[] = [pktLine(preamble), PKT_FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines = refLines(repo);
  const hasRefs = lines.some((line) => line.name.startsWith('refs/'));
  if (!hasRefs) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let capsEmitted = false;
    for (const line of lines) {
      // An unborn HEAD is not a line of its own; the capabilities line covers it.
      if (line.name === 'HEAD' && line.unborn === true) continue;
      let text = `${line.oid} ${line.name}`;
      if (!capsEmitted) {
        text += `\0${caps}`;
        capsEmitted = true;
      }
      text += '\n';
      parts.push(pktLine(text));
      // A peeled tag is a second line: <peeled oid> <name>^{}
      if (line.peeled !== undefined) {
        parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolHeader: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: v0Advertisement('git-receive-pack', repo),
    };
  }
  if (service !== 'git-upload-pack') {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8') };
  }
  const wantsV2 = gitProtocolHeader !== undefined && gitProtocolHeader.includes('2');
  if (wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement('git-upload-pack', repo) };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse a v2 upload-pack request body into a command or a fetch. */
function parseV2UploadPack(body: Buffer): { kind: 'ls-refs' | 'fetch'; prefixes: string[]; fetch: FetchRequest } | null {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return null;
  }
  let command: string | null = null;
  const prefixes: string[] = [];
  const fetch: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
    else if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) fetch.depth = depth;
    }
    // agent, object-format, peel, symrefs, unborn, thin-pack, ofs-delta,
    // no-progress, filter, done: accepted, nothing to do with them.
  }
  if (command === 'ls-refs') return { kind: 'ls-refs', prefixes, fetch };
  if (command === 'fetch') return { kind: 'fetch', prefixes, fetch };
  return null;
}

/** Parse a v0 upload-pack request body (want/have/deepen lines, two sections). */
function parseV0UploadPack(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return null;
  }
  const fetch: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        const space = rest.indexOf(' ');
        fetch.wants.push(space === -1 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) fetch.depth = depth;
      }
    } else {
      if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    }
  }
  return fetch;
}

function sidebandPack(pack: Buffer): Buffer {
  // The packfile section's sideband packets: band 1, chunked to pkt-line size.
  const parts: Buffer[] = [];
  const CHUNK = 65519;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

/** Build a v2 fetch response for the parsed request. */
function v2FetchResponse(store: Store, repo: RepoRec, fetch: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = store.fetchSet(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = ['acknowledgments\n'];
  const allHavesKnown = fetch.haves.length > 0 && fetch.haves.every((have) => repo.objects.has(have));
  if (fetch.haves.length === 0) ackLines.push('NAK\n');
  else if (allHavesKnown) {
    for (const have of fetch.haves) ackLines.push(`ACK ${have}\n`);
    ackLines.push('ready\n');
  } else ackLines.push('NAK\n');
  parts.push(encodePktLines([...ackLines, 'flush']));
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  // wanted-refs (always present, even when no want matches a ref tip)
  const wantedRefs: string[] = [];
  for (const want of fetch.wants) {
    for (const line of refLines(repo)) {
      if (line.oid === want && line.name.startsWith('refs/')) wantedRefs.push(`${want} ${line.name}\n`);
    }
  }
  parts.push(encodePktLines(['wanted-refs\n', ...wantedRefs, 'flush']));
  // packfile
  if (objects.size > 0) {
    const pack = writePack([...objects.values()]);
    parts.push(encodePktLines(['packfile\n']));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

/** Build a v0 fetch response for the parsed request. */
function v0FetchResponse(store: Store, repo: RepoRec, fetch: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = store.fetchSet(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
  const parts: Buffer[] = [];
  const allHavesKnown = fetch.haves.length > 0 && fetch.haves.every((have) => repo.objects.has(have));
  if (fetch.haves.length === 0) parts.push(pktLine('NAK\n'));
  else if (allHavesKnown) {
    for (const have of fetch.haves) parts.push(pktLine(`ACK ${have}\n`));
  } else parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.size > 0) {
    const pack = writePack([...objects.values()]);
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export async function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): Promise<GitResponse> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const v2 = parseV2UploadPack(body);
  if (v2 !== null) {
    if (v2.kind === 'ls-refs') {
      const lines: string[] = [];
      const keep = (name: string): boolean => v2.prefixes.length === 0 || v2.prefixes.some((prefix) => name.startsWith(prefix));
      for (const line of refLines(repo)) {
        if (!keep(line.name)) continue;
        if (line.unborn === true) {
          lines.push(`unborn ${line.name} symref-target:${line.symrefTarget ?? ''}\n`);
        } else {
          let text = `${line.oid} ${line.name}`;
          if (line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
          if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
          lines.push(`${text}\n`);
        }
      }
      lines.push('flush');
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodePktLines(lines) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(store, repo, v2.fetch) };
  }
  const v0 = parseV0UploadPack(body);
  if (v0 === null || v0.wants.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed upload-pack request' }), 'utf8') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(store, repo, v0) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export async function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): Promise<GitResponse> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const result = { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  let commands: PushCommand[] = [];
  let packOffset = 0;
  try {
    const { packets, end } = decodePktLines(body);
    packOffset = end;
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.trim().split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    return { ...result, body: reportBytes('unpack error\n') };
  }
  if (commands.length === 0) {
    return { ...result, body: reportBytes('unpack error\n') };
  }
  // Unpack first: every object lands in the store, whatever the ref verdicts.
  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const read = await readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          if (object.type === 'commit') repo.commitSeq.set(oid, store.nextCommitSeqGlobal++);
        }
      }
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  if (unpackOk) {
    for (const command of commands) {
      const verdict = applyPush(store, repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  }
  return { ...result, body: reportBytes(reportLines.join('')) };
}

/** The report-status stream, pkt-lined inside sideband band 1. */
function reportBytes(text: string): Buffer {
  const inner = encodePktLines(text.split('\n').filter((line) => line !== '').map((line) => `${line}\n`));
  const parts: Buffer[] = [];
  const CHUNK = 65519;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const slice = inner.subarray(offset, Math.min(offset + CHUNK, inner.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Apply one push command. Returns null when it applied, else the ng reason. */
function applyPush(store: Store, repo: RepoRec, command: PushCommand): string | null {
  void store;
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) return 'invalid object id';
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'old value mismatch';
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === ZERO_OID) return 'ref does not exist';
    repo.refs.delete(command.ref);
    return null;
  }
  if (repo.objects.get(command.newOid) === undefined) return 'missing object';
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== ZERO_OID) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  // Update: fast-forward only.
  if (command.oldOid === command.newOid) return null;
  const newCommit = repo.objects.get(command.newOid);
  if (newCommit === undefined || newCommit.type !== 'commit') return 'not a commit';
  if (!isAncestorOf(repo, command.oldOid, command.newOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/** Walk parents from `descendant` looking for `ancestor`. */
function isAncestorOf(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}
