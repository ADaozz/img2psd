import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../facts/groups.ts';

// Crash recovery on this host is safe only when the recorded owner no longer exists.
export async function acquireReviewLock(jobDir: string): Promise<() => Promise<void>> {
  const lock = join(jobDir, '.review-running');
  for (let n = 0; n < 2; n++) {
    try {
      await mkdir(lock);
      await writeAtomic(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readFile(join(lock, 'owner.json'), 'utf8').then(JSON.parse, () => undefined) as { pid: number; host: string } | undefined;
      if (!owner) {
        if (Date.now() - (await stat(lock)).mtimeMs < 30_000) throw new Error('审核锁正在初始化，请稍后重试');
      } else {
        if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('审核锁属于其他主机或 owner 无效，需检查原进程后显式恢复');
        try { process.kill(owner.pid, 0); throw new Error('当前 job 已有审核执行'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      }
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw new Error('无法取得审核锁');
}
