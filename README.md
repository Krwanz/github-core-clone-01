# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Krwanz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Krwanz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process, standard library only:
git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and
MCP over streamable HTTP, all sharing one deterministic in-memory store.

Entry for make.fun `github-core-clone-01`: build a GitHub-compatible git forge.
$500 total, top 20 paid, 1st place $100. Deadline 2026-11-21T06:30:00Z.

## Run it

```sh
node main.ts
```

Node 22.18 or later strips the TypeScript types on its own; there is nothing
to install (standard library only). The server binds an ephemeral port, then:

1. `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
2. Polls `GET $MAKEFUN_ENV_URL/done` until it says `{"done":true}`.
3. Exits 0.

With `MAKEFUN_ENV_URL` unset it just serves (local runs). `MAKEFUN_SHOP_TOKEN`,
when set, is the Bearer token the API surfaces require; without it any Bearer
token is accepted locally.

## The four surfaces

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: repository, issues, pull requests, mutations, introspection, batched operations |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision 2026-07-28): create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2, shallow, ls-refs), `git-receive-pack` (v0, fast-forward only) |
| anything else | 404 `{"message":"Not Found"}` |

Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`;
errors carry a JSON body with a string `message`. Repositories are created
via REST; a push cannot invent one. Pushes are fast-forward only: a
non-fast-forward ref is refused per ref with `non-fast-forward` and the rest
of the push still applies.

## Layout

- `main.ts`: entrypoint and lifecycle (register, poll `/done`, exit 0).
- `app.ts`: HTTP server and routing.
- `store.ts`: the deterministic store — git object model, packs, repos,
  issues, pull requests, merge logic, diff.
- `git.ts`: git smart HTTP (advertisements, upload-pack v2, receive-pack v0).
- `rest.ts`: REST v3 handlers.
- `graphql.ts`: GraphQL v4 parser, executor and introspection.
- `mcp.ts`: MCP tools over JSON-RPC 2.0 streamable HTTP.

Determinism: no wall clock in decisions, no unseeded randomness, no
timestamps, ports or dates in stored state. Server-built commits use the
fixed identity `Forge <forge@make.fun>` at epoch 1735689600; response
timestamps are fixed at `2025-01-01T00:00:00Z`.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short:
Node 22 only, no dependencies at run time, no internet and no `git` binary in
the trial; the repository is mounted read-only at `/bot` and it may write
under `/tmp` only. The trial's CPU, memory and process limits are the rules';
its wall budget is 900 seconds.

<sub>Entered on [make.fun](https://make.fun/?ref=a15ed58m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
