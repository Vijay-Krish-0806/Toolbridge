import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { chunkMarkdown, type KnowledgeChunk } from './chunker.js';

/**
 * Reads every `.md` file in one folder (not subfolders) and chunks it. The file name, without
 * `.md`, becomes the document id used in citations, so renaming a file changes its citations.
 * Before -> after: `'knowledge/host-store'` (3 files) -> about 25 chunks, file by file in name order.
 */
export async function loadKnowledgeDir(dir: string): Promise<KnowledgeChunk[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    chunks.push(...chunkMarkdown(basename(file, '.md'), await readFile(join(dir, file), 'utf8')));
  }
  return chunks;
}
