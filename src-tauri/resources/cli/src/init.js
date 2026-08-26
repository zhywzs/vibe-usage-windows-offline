import { createInterface } from 'node:readline';
import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './tools.js';
import { bigHeader, success, warn, dim, divider } from './output.js';

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isDaemonPlatform() {
  return process.platform === 'linux' || process.platform === 'darwin';
}

// Offline first-run setup: capture a stable hostname, detect tools, and run
// an initial local import. No account, no key, no network.
export async function runInit(options = {}) {
  const { codexExtraHome } = options;

  console.log(bigHeader());

  const existing = loadConfig();
  const host = existing?.hostname || osHostname().replace(/\.local$/, '');

  const config = {
    hostname: host,
    ...(existing?.codexExtraHome ? { codexExtraHome: existing.codexExtraHome } : {}),
  };
  saveConfig(config);

  const tools = detectInstalledTools({ codexExtraHome: config.codexExtraHome });
  if (tools.length > 0) {
    console.log(success(`检测到 ${tools.length} 款工具: ${dim(tools.map(t => t.name).join(' · '))}`));
  } else {
    console.log(warn('未检测到 AI 编码工具，安装后重新运行即可。'));
  }
  console.log(dim('  完全本地运行：用量数据保存在本机，不上传任何内容。'));

  console.log();
  console.log(divider());
  console.log();

  await runSync({ codexExtraHome });

  if (isDaemonPlatform()) {
    if (process.stdin.isTTY) {
      console.log();
      const answer = await prompt(`开启后台自动统计？${dim('(推荐)')} [Y/n] `);
      const normalized = answer.toLowerCase();
      if (normalized === '' || normalized === 'y' || normalized === 'yes') {
        const { manageDaemon } = await import('./daemon-service.js');
        await manageDaemon('install');
      } else {
        console.log();
        console.log(dim('随时运行 `npx @vibe-cafe/vibe-usage daemon install` 开启后台统计。'));
      }
    } else {
      console.log();
      console.log(dim('提示: 运行 `npx @vibe-cafe/vibe-usage daemon install` 开启后台自动统计。'));
    }
  }
}
