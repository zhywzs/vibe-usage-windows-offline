import { createInterface } from 'node:readline';
import { runSync } from './sync.js';
import { clearStore, loadStore } from './store.js';
import { success, failure, dim } from './output.js';

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runReset(args = [], deps = {}) {
  // Injectable for tests — the production defaults hit readline and the real
  // sync pipeline.
  const ask = deps.prompt ?? prompt;
  const resync = deps.runSync ?? runSync;

  // --local / --host were host-vs-account scoping flags in the online era.
  // The local store only ever held this machine's data, so both aliases now
  // mean the same thing; they stay accepted so existing scripts don't break.
  const hostOnly = args.includes('--local') || args.includes('--host');

  const answer = await ask(
    hostOnly
      ? '将删除本机已统计的用量数据，并从本地日志重新统计，继续? (y/N) '
      : '将删除全部本地用量数据，并从本地日志重新统计，继续? (y/N) ',
  );
  if (answer.toLowerCase() !== 'y') {
    console.log(dim('已取消。'));
    return;
  }

  const before = Object.keys(loadStore().buckets).length;
  console.log(dim(`  正在清除本地用量数据（${before} buckets）...`));
  try {
    clearStore();
  } catch (err) {
    console.error(failure(`清除本地数据失败: ${err.message}`));
    process.exit(1);
  }
  console.log(success('已清除本地用量数据。'));

  // The store is gone, so every local item must count as "changed" on the
  // re-sync below. The Codex parser cache is intentionally kept so the
  // full re-import doesn't also require a full raw-log rescan.
  console.log();
  console.log(dim('  从本地日志重新统计...'));
  await resync();

  console.log();
  console.log(dim('数据已重建。'));
}
