import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesHash } from '../facts/hash.ts';

// Include KRA and reports, not just the exported preview.
export async function rasterDeliverablesHash(directory: string, names: string[]): Promise<string> {
  const files = await Promise.all([...names].sort().map(async name => [name, bytesHash(await readFile(join(directory, name)))]));
  return bytesHash(Buffer.from(JSON.stringify(files)));
}
