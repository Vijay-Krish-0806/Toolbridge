/**
 * Step 3.3: splits a markdown document into chunks, one per section (a heading and the text under
 * it). Policies are already organised by topic under headings, so a section is a natural unit to
 * retrieve and to cite. A section longer than `maxChars` is split at paragraph breaks.
 *
 * A small line-based splitter instead of a markdown parser: we write these files ourselves, and
 * the only syntax that matters is `#` headings and code fences (a `#` inside a fence is not one).
 */

export interface KnowledgeChunk {
  /** Stable citation id: `<docId>#<section-slug>`, for example `refund-policy#damaged-items`. */
  id: string;
  /** The file name without `.md`. */
  docId: string;
  /** The document's first `#` heading. */
  title: string;
  /** Headings from the title down to this section, for example ['Refund policy', 'Damaged items']. */
  headingPath: string[];
  /** The section's text, without its heading line. */
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Chunks one markdown document by heading.
 * Before -> after: `('refund-policy', '# Refund policy\n...\n## Damaged items\nAsk for a photo...')`
 * -> `[{ id: 'refund-policy#intro', ... }, { id: 'refund-policy#damaged-items',
 * headingPath: ['Refund policy', 'Damaged items'], text: 'Ask for a photo...' }]`.
 */
export function chunkMarkdown(docId: string, markdown: string, maxChars = 1500): KnowledgeChunk[] {
  const sections = splitSections(markdown);
  const title = sections.find((s) => s.path.length > 0)?.path[0] ?? docId;
  const used = new Set<string>();
  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (text === '') continue;
    const headingPath = section.path.length > 0 ? section.path : [title];
    const base = uniqueSlug(slugify(headingPath.slice(1).join(' ')) || 'intro', used);
    splitLong(text, maxChars).forEach((part, i) => {
      chunks.push({
        id: `${docId}#${i === 0 ? base : `${base}-part-${String(i + 1)}`}`,
        docId,
        title,
        headingPath,
        text: part,
      });
    });
  }
  return chunks;
}

/**
 * The text that gets embedded: the heading path, then the section. A paragraph such as "within
 * 7 days" means little alone; with "Refund policy > Damaged items" in front it can be found.
 * Before -> after: a damaged-items chunk -> `'Refund policy > Damaged items\n\nAsk the customer...'`.
 */
export function buildChunkText(chunk: KnowledgeChunk): string {
  return `${chunk.headingPath.join(' > ')}\n\n${chunk.text}`;
}

interface Section {
  path: string[];
  lines: string[];
}

/**
 * Walks the lines once, starting a new section at every heading outside a code fence. The path
 * keeps one heading per level, so a `###` under a `##` gets both.
 */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ path: [], lines: [] }];
  const stack: { level: number; text: string }[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text: heading[2] });
      sections.push({ path: stack.map((h) => h.text), lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections;
}

/**
 * Splits text longer than `maxChars` at blank lines, packing whole paragraphs into each part. A
 * single paragraph longer than the limit stays whole: cutting mid-sentence would hurt more.
 */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current !== '' && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current);
      current = '';
    }
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** `'Damaged items'` -> `'damaged-items'`. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Adds `-2`, `-3`... when two sections of one document share a heading. */
function uniqueSlug(slug: string, used: Set<string>): string {
  let candidate = slug;
  for (let n = 2; used.has(candidate); n++) candidate = `${slug}-${String(n)}`;
  used.add(candidate);
  return candidate;
}
