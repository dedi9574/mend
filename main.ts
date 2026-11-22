// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order, as [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- sections 3 and 5: a file's lines, and matching lines at three tiers ----

/** A file's text split at its own line break, with whether it ends with one (section 3). */
function fileParts(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Positions i at or after `from` where `o` matches the file's lines at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `o` occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and for a context line the index of its line in O. */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines N writes for an occurrence at `pos` (section 5): context lines as the file's own lines, tier-2 re-indentation of the rest. */
function buildNew(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  if (o.length === 0) return n.map((x) => x.text);
  const f = leadWs(fileLines[pos]!);
  const p = leadWs(o[0]!);
  return n.map((x) => {
    if (x.ctx >= 0) return fileLines[pos + x.ctx]!;
    if (tier !== 2) return x.text;
    if (x.text === '' || /^[ \t]+$/.test(x.text)) return x.text;
    return x.text.startsWith(p) ? f + x.text.slice(p.length) : x.text;
  });
}

// ---- section 6: unified diffs ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoNL: boolean;
  hasPlus: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  haveDash: boolean;
  headed: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body, from the line after its header: O, N, and the `\` line rules. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  let j = start;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]![0] === ' ' || body[k]![0] === '+') lastCtxPlus = k;
    if (body[k]![0] === '+') lastPlus = k;
  }
  const followedByBackslash = (k: number): boolean => k >= 0 && k < body.length && body[k]![0] === '\\';
  const noNL = lastCtxPlus >= 0 && followedByBackslash(lastCtxPlus + 1);
  const plusNoNL = lastPlus >= 0 && followedByBackslash(lastPlus + 1);
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { hunk: { a, o, n, noNL, plusNoNL, hasPlus: lastPlus >= 0 }, next: j };
}

/** A section's hunks applied to a file's lines, in order (section 6). */
function applyHunks(parts: { br: string; lines: string[]; final: boolean }, hunks: Hunk[], strict: boolean, path: string): { br: string; lines: string[]; final: boolean } {
  let lines = [...parts.lines];
  let final = parts.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const rep = buildNew(lines, pos, h.o, h.n, found.tier);
      const runsToEnd = pos + h.o.length === lines.length;
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + h.o.length)];
      if (runsToEnd) final = !h.noNL;
    } else {
      const idx = Math.min(Math.max(h.a + d, 0), lines.length);
      const rep = h.n.map((x) => x.text);
      const runsToEnd = idx === lines.length;
      lines = [...lines.slice(0, idx), ...rep, ...lines.slice(idx)];
      if (runsToEnd) final = !h.noNL;
    }
    d += h.n.length - h.o.length;
  }
  return { br: parts.br, lines, final };
}

function unifiedSectionEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldPath = s.haveDash ? (s.dashOld ?? null) : (s.renameOld ?? s.gitOld);
  const newPath = s.haveDash ? (s.dashNew ?? null) : (s.renameNew ?? s.gitNew);
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of s.hunks) for (const x of h.n) if (x.ctx < 0) plus.push(x.text);
      let noNL = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        if (s.hunks[k]!.hasPlus) {
          noNL = s.hunks[k]!.plusNoNL;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const res = applyHunks(fileParts(tree.get(oldPath)!), s.hunks, strict, oldPath);
      tree.now.set(newPath, joinFile(res.lines, res.br, res.final));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldPath ?? newPath;
    if (p === null) return;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const res = applyHunks(fileParts(tree.get(p)!), s.hunks, strict, p);
    tree.now.set(p, joinFile(res.lines, res.br, res.final));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const start = (): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld: null,
      gitNew: null,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: null,
      renameNew: null,
      newFile: false,
      deletedFile: false,
      haveDash: false,
      headed: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = start();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1, parseInt(m[1]!, 10));
      cur.hunks.push(parsed.hunk);
      cur.headed = true;
      i = parsed.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.headed && !cur.haveDash) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        cur.haveDash = true;
      } else {
        const s = start();
        s.dashOld = dashPath(line);
        s.dashNew = dashPath(lines[i + 1]!);
        s.haveDash = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && !cur.headed) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = fileParts(cur);
    const found = findTier(parts.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nItems: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildNew(parts.lines, pos, oldLines, nItems, found.tier);
    const lines = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(lines, parts.br, parts.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const l = lines[j]!.trimEnd();
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
      if (l === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const l = lines[j]!.trimEnd();
      if (l === '<<<<<<< SEARCH') break;
      if (l === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, raw: string[], start: number, updateLine: number, strict: boolean): Edit {
  let addLines: string[] = [];
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  if (kind === 'add') {
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') addLines.push('');
      else if (l[0] === '+') addLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${start + k + 1}`);
    }
  } else if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${start + 1}`);
  } else {
    let k = 0;
    if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.slice(13).trim();
      k = 1;
    }
    let cur: V4aChunk | null = null;
    const open = (anchor: string | null): void => {
      cur = { anchor, o: [], n: [], eof: false };
      chunks.push(cur);
    };
    while (k < raw.length) {
      const l = raw[k]!;
      if (l.startsWith('@@')) {
        const a = l.slice(2).trim();
        open(a === '' ? null : a);
        k += 1;
        continue;
      }
      if (l === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${start + k + 1}`);
        cur.eof = true;
        cur = null;
        k += 1;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (cur === null) {
          if (chunks.length === 0) open(null);
          else throw new Exit2(`error: parse ${start + k + 1}`);
        }
        if (l === '') {
          cur.o.push('');
          cur.n.push({ text: '', ctx: cur.o.length - 1 });
        } else if (l[0] === ' ') {
          cur.o.push(l.slice(1));
          cur.n.push({ text: l.slice(1), ctx: cur.o.length - 1 });
        } else if (l[0] === '-') {
          cur.o.push(l.slice(1));
        } else {
          cur.n.push({ text: l.slice(1), ctx: -1 });
        }
        k += 1;
        continue;
      }
      throw new Exit2(`error: parse ${start + k + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = fileParts(cur);
    let lines = [...parts.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const idx = ch.eof ? lines.length : cursor;
        const rep = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, idx), ...rep, ...lines.slice(idx)];
        cursor = idx + rep.length;
      } else {
        const found = findTier(lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const q of found.occ) {
          if (ch.eof && q + ch.o.length !== lines.length) continue;
          pos = q;
          break;
        }
        if (pos === null) throw new Fail('no-match', path);
        const rep = buildNew(lines, pos, ch.o, ch.n, found.tier);
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + ch.o.length)];
        cursor = pos + rep.length;
      }
    }
    const text = joinFile(lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, start, i + 1, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  const moveTo = new Map<string, string>();
  for (const [o, n] of tree.moves) moveTo.set(o, n);
  for (const [o] of tree.moves) {
    if (tree.original(o) === null) continue;
    let dest = moveTo.get(o)!;
    const seen = new Set<string>([o]);
    while (moveTo.has(dest) && !seen.has(dest)) {
      seen.add(dest);
      dest = moveTo.get(dest)!;
    }
    if (tree.get(o) !== null || tree.get(dest) === null || tree.original(dest) !== null) continue;
    covered.add(o);
    covered.add(dest);
    rows.push({ key: dest, text: `R ${o} -> ${dest}` });
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
