import { readFileSync } from 'node:fs';

// 读取项目根目录的 .env。已存在的环境变量优先，不会被文件覆盖；
// 支持 # 注释、KEY=VALUE、成对引号；L2D_NO_DOTENV=1 可关闭。
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    if (env[key] !== undefined) continue;
    let value = rest.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    loaded++;
  }
  return loaded;
}
