// app.ts — the HTTP server: one process, one store, four surfaces.
//
//   GET  /healthz                              the env's boot probe (200)
//   POST /mcp                                   MCP (JSON-RPC 2.0)
//   POST /api/graphql                           GraphQL v4
//   /api/v3/*                                   REST v3
//   /{owner}/{repo}.git/info/refs              git advertisements
//   /{owner}/{repo}.git/git-upload-pack         git fetch (v2/v0)
//   /{owner}/{repo}.git/git-receive-pack        git push (v0)
//
// Bodies are capped (128 MiB) so a bad client cannot grow the process without
// bound. A handler that throws answers 500 JSON and never kills the server:
// the suite's error-survival checks depend on the forge staying up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export interface AppHandle {
  server: Server;
  store: Store;
  port: number;
}

function jsonBody(status: number, value: unknown): { status: number; headers: Record<string, string>; body: Buffer } {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function toRestRequest(request: IncomingMessage, body: Buffer, path: string, query: URLSearchParams): RestRequest {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
  }
  return {
    method: request.method ?? 'GET',
    path,
    query,
    headers,
    host: request.headers.host ?? 'localhost',
    body,
  };
}

export function createApp(store: Store): AppHandle {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        const bad = jsonBody(400, { message: 'bad request path' });
        response.writeHead(bad.status, bad.headers).end(bad.body);
        return;
      }
      const method = request.method ?? 'GET';

      // The env's boot probe.
      if (path === '/healthz' && method === 'GET') {
        const ok = jsonBody(200, { ok: true });
        response.writeHead(ok.status, ok.headers).end(ok.body);
        return;
      }
      if (path === '/' && method === 'GET') {
        const ok = jsonBody(200, { ok: true, service: 'forge', version: '1.0.0' });
        response.writeHead(ok.status, ok.headers).end(ok.body);
        return;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = needsBody ? await readBody(request) : Buffer.alloc(0);
      const restRequest = toRestRequest(request, body, path, url.searchParams);

      let answer: { status: number; headers: Record<string, string>; body: Buffer };

      if (path === '/mcp' && method === 'POST') {
        answer = handleMcp(store, restRequest);
      } else if (path === '/api/graphql' && method === 'POST') {
        answer = handleGraphQL(store, restRequest);
      } else if (path.startsWith('/api/v3')) {
        answer = await handleRest(store, restRequest);
      } else {
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const action = gitMatch[3] as string;
          if (action === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const protocol = request.headers['git-protocol'];
            const git = handleInfoRefs(store, owner, repoName, service, typeof protocol === 'string' ? protocol : undefined);
            answer = { status: git.status, headers: { 'content-type': git.contentType }, body: git.body };
          } else if (action === 'git-upload-pack' && method === 'POST') {
            const git = await handleUploadPack(store, owner, repoName, body);
            answer = { status: git.status, headers: { 'content-type': git.contentType }, body: git.body };
          } else if (action === 'git-receive-pack' && method === 'POST') {
            const git = await handleReceivePack(store, owner, repoName, body);
            answer = { status: git.status, headers: { 'content-type': git.contentType }, body: git.body };
          } else {
            answer = jsonBody(404, { message: 'Not Found' });
          }
        } else {
          answer = jsonBody(404, { message: 'Not Found' });
        }
      }

      response.writeHead(answer.status, answer.headers).end(answer.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';
      try {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message }));
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });

  server.on('clientError', (error: Error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n{"message":"bad request"}');
    } catch {
      socket.destroy();
    }
    void error;
  });

  return { server, store, port: 0 };
}

export async function listen(app: AppHandle, port = 0): Promise<number> {
  await new Promise<void>((resolve) => {
    app.server.listen(port, '0.0.0.0', () => resolve());
  });
  const address = app.server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  app.port = actual;
  return actual;
}
