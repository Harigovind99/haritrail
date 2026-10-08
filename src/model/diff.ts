import { Step } from './types';

/** Rebuild before/after text for a change. Full-file when the transcript kept the original. */
export function diffSides(s: Step): { before: string; after: string; full: boolean } {
  if (s.originalFile !== undefined) {
    if (s.writtenContent !== undefined) {
      return { before: s.originalFile, after: s.writtenContent, full: true };
    }
    if (s.edits?.length) {
      let after = s.originalFile;
      let ok = true;
      for (const e of s.edits) {
        if (e.oldText === '') {
          ok = false;
          break;
        }
        if (e.replaceAll) {
          after = after.split(e.oldText).join(e.newText);
        } else {
          const at = after.indexOf(e.oldText);
          if (at < 0) {
            ok = false;
            break;
          }
          after = after.slice(0, at) + e.newText + after.slice(at + e.oldText.length);
        }
      }
      if (ok) {
        return { before: s.originalFile, after, full: true };
      }
    }
  }
  if (s.edits?.length) {
    const sep = '\n\n/* ... */\n\n';
    return { before: s.edits.map((e) => e.oldText).join(sep), after: s.edits.map((e) => e.newText).join(sep), full: false };
  }
  if (s.writtenContent !== undefined) {
    return { before: '', after: s.writtenContent, full: s.kind === 'create' };
  }
  return { before: '', after: '', full: false };
}

