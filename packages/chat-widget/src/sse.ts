/**
 * A tiny Server-Sent Events parser (the stream format of GET /runs/:id/events). The browser's
 * own EventSource cannot send an Authorization header, so the widget reads the stream with
 * fetch and parses it here.
 *
 * Blocks are separated by a blank line; each line is `field: value`. Lines starting with ":" are
 * comments (the server's heartbeat). Chunks can split a block anywhere, so text is buffered.
 */
export interface SseBlock {
  id?: string;
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  /**
   * Adds received text; returns the blocks that are now complete.
   * Before -> after: push('id: 1\nevent: a\nda') -> []; push('ta: {}\n\n') -> [{ id: '1', event: 'a', data: '{}' }].
   */
  push(chunk: string): SseBlock[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const blocks: SseBlock[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const block: SseBlock = { data: '' };
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'id') block.id = value;
        else if (field === 'event') block.event = value;
      }
      if (data.length > 0) {
        block.data = data.join('\n');
        blocks.push(block);
      }
    }
    return blocks;
  }
}
