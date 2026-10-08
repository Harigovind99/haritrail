import * as fs from 'fs';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHUNK = 4 * 1024 * 1024;

/**
 * Reads a JSONL file incrementally. Each `poll()` returns only the records appended
 * since the last call. Partial last lines are held back (as raw bytes, so multi-byte
 * characters are never split) until their newline arrives, and a shrinking or replaced
 * file is reported as 'reset' so the caller can rebuild from scratch.
 */
export class JsonlTailer {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private busy = false;
  private ino?: number;
  badLines = 0;

  constructor(readonly file: string) {}

  /** Returns new records, `null` if nothing new, or `'reset'` if the file was replaced/truncated. */
  async poll(): Promise<any[] | null | 'reset'> {
    if (this.busy) {
      return null;
    }
    this.busy = true;
    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(this.file);
      } catch {
        return null;
      }
      const replaced = this.ino !== undefined && stat.ino !== 0 && this.ino !== 0 && stat.ino !== this.ino;
      if (replaced || stat.size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.ino = stat.ino;
        return 'reset';
      }
      this.ino = stat.ino;
      if (stat.size === this.offset) {
        return null;
      }
      const records: any[] = [];
      const fh = await fs.promises.open(this.file, 'r');
      try {
        const end = stat.size;
        while (this.offset < end) {
          const len = Math.min(CHUNK, end - this.offset);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, this.offset);
          if (bytesRead <= 0) {
            break;
          }
          this.offset += bytesRead;
          const data = this.pending.length ? Buffer.concat([this.pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          const cut = data.lastIndexOf(0x0a);
          if (cut === -1) {
            this.pending = Buffer.from(data);
            continue;
          }
          this.pending = Buffer.from(data.subarray(cut + 1));
          const text = data.toString('utf8', 0, cut);
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              records.push(JSON.parse(trimmed));
            } catch {
              this.badLines++;
            }
          }
        }
      } finally {
        await fh.close();
      }
      return records.length ? records : null;
    } finally {
      this.busy = false;
    }
  }
}
