import { runSync } from './sync.js';
import { dim } from './output.js';

const INTERVAL = 30 * 60_000; // 30 minutes

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(dim(`[${ts}] ${msg}\n`));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDaemon({ codexExtraHome } = {}) {
  log('daemon started (local sync every 30m, Ctrl+C to stop)');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ throws: true, quiet: true, surface: 'daemon', codexExtraHome });
    } catch (err) {
      log(`sync error: ${err.message}`);
    }
    await sleep(INTERVAL);
  }
}
