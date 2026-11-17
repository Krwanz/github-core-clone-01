// main.ts — the entrypoint: `node main.ts`.
//
//   1. Listen on an ephemeral port (port 0; never a fixed one).
//   2. POST {"port": n} to $MAKEFUN_ENV_URL/register.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done; on {"done": true} exit 0.
// Without MAKEFUN_ENV_URL (a local run) it just serves on the ephemeral port
// and waits for a signal.

import { Store } from './store.ts';
import { createApp, listen } from './app.ts';

const POLL_INTERVAL_MS = 1000;

function log(message: string): void {
  process.stderr.write(`[forge] ${message}\n`);
}

async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${envUrl.replace(/\/+$/, '')}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) return true;
      log(`register attempt ${attempt}: HTTP ${response.status}`);
    } catch (error) {
      log(`register attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (response.status === 200) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (error) {
      log(`done poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const app = createApp(store);
  const port = await listen(app);
  log(`listening on port ${port}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    log('MAKEFUN_ENV_URL is not set; serving without registering (local run)');
    return;
  }
  const registered = await register(envUrl, port);
  if (!registered) {
    log('could not register with the environment; exiting 1');
    process.exit(1);
  }
  log(`registered at ${envUrl} (port ${port})`);
  await waitForDone(envUrl);
  log('the suite is done; exiting 0');
  app.server.close();
  process.exit(0);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
