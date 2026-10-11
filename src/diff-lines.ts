export interface DiffSpan {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  spans: DiffSpan[];
}

export interface InlineDiff {
  lines: DiffLine[];
  previousPath: string | null;
  binary: boolean;
}

interface RawLine {
  kind: DiffLine['kind'];
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export interface DiffLinesOptions {
  previousPath?: string | null;
  binary?: boolean;
}

export function diffLines(diffText: string, options: DiffLinesOptions = {}): InlineDiff {
  const lines: DiffLine[] = [];
  let hunk: RawLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  let previousPath: string | null = null;
  let binary = false;

  const flushHunk = (): void => {
    lines.push(...withSpans(hunk));
    hunk = [];
  };

  for (const line of diffText.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('Binary files ')) {
      binary = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      previousPath = line.slice('rename from '.length).trim();
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      flushHunk();
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) {
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === ' ') {
      hunk.push({ kind: 'context', oldNumber, newNumber, text });
      oldNumber += 1;
      newNumber += 1;
      continue;
    }
    if (marker === '-') {
      hunk.push({ kind: 'removed', oldNumber, newNumber: null, text });
      oldNumber += 1;
      continue;
    }
    if (marker === '+') {
      hunk.push({ kind: 'added', oldNumber: null, newNumber, text });
      newNumber += 1;
    }
  }
  flushHunk();

  const selectedPath = options.previousPath?.trim() ?? '';
  return {
    lines,
    previousPath: selectedPath !== '' ? selectedPath : previousPath,
    binary: options.binary === true || binary,
  };
}

function withSpans(lines: RawLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.kind !== 'removed') {
      if (line) {
        result.push(unchanged(line));
      }
      index += 1;
      continue;
    }
    let removedEnd = index;
    while (removedEnd < lines.length && lines[removedEnd]?.kind === 'removed') {
      removedEnd += 1;
    }
    let addedEnd = removedEnd;
    while (addedEnd < lines.length && lines[addedEnd]?.kind === 'added') {
      addedEnd += 1;
    }
    const removed = lines.slice(index, removedEnd);
    const added = lines.slice(removedEnd, addedEnd);
    if (added.length === removed.length) {
      const paired = removed.map((before, pair) => intraSpans(before.text, added[pair]?.text ?? ''));
      for (let pair = 0; pair < removed.length; pair += 1) {
        const before = removed[pair];
        if (before) {
          result.push({ ...before, spans: paired[pair]?.removed ?? [{ text: before.text, changed: false }] });
        }
      }
      for (let pair = 0; pair < added.length; pair += 1) {
        const after = added[pair];
        if (after) {
          result.push({ ...after, spans: paired[pair]?.added ?? [{ text: after.text, changed: false }] });
        }
      }
    } else {
      for (const plain of [...removed, ...added]) {
        result.push(unchanged(plain));
      }
    }
    index = addedEnd;
  }
  return result;
}

function unchanged(line: RawLine): DiffLine {
  return { ...line, spans: [{ text: line.text, changed: false }] };
}

function intraSpans(before: string, after: string): { removed: DiffSpan[]; added: DiffSpan[] } {
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const { oldChanged, newChanged } = changedTokens(oldTokens, newTokens);
  return {
    removed: coalesce(oldTokens, oldChanged),
    added: coalesce(newTokens, newChanged),
  };
}

function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

function changedTokens(before: string[], after: string[]): { oldChanged: boolean[]; newChanged: boolean[] } {
  const oldCount = before.length;
  const newCount = after.length;
  const lengths: number[][] = Array.from({ length: oldCount + 1 }, () => Array(newCount + 1).fill(0));
  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
      const nextOld = lengths[oldIndex + 1]?.[newIndex] ?? 0;
      const nextNew = lengths[oldIndex]?.[newIndex + 1] ?? 0;
      const diagonal = lengths[oldIndex + 1]?.[newIndex + 1] ?? 0;
      lengths[oldIndex]![newIndex] = before[oldIndex] === after[newIndex] ? diagonal + 1 : Math.max(nextOld, nextNew);
    }
  }
  const oldChanged = Array<boolean>(oldCount).fill(true);
  const newChanged = Array<boolean>(newCount).fill(true);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldCount && newIndex < newCount) {
    if (before[oldIndex] === after[newIndex]) {
      oldChanged[oldIndex] = false;
      newChanged[newIndex] = false;
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const dropOld = lengths[oldIndex + 1]?.[newIndex] ?? 0;
    const dropNew = lengths[oldIndex]?.[newIndex + 1] ?? 0;
    if (dropOld >= dropNew) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }
  return { oldChanged, newChanged };
}

export interface FoldedLineRow {
  kind: 'line';
  line: DiffLine;
}

export interface FoldedFoldRow {
  kind: 'fold';
  id: string;
  hidden: number;
  label: string;
  tooLarge: boolean;
  hasStart: boolean;
  hasEnd: boolean;
}

export type FoldedRow = FoldedLineRow | FoldedFoldRow;

export interface FoldedDiff {
  rows: FoldedRow[];
  previousPath: string | null;
  binary: boolean;
}

export interface FoldSides {
  oldText: string;
  newText: string;
}

export interface FoldOpening {
  fromStart: number;
  fromEnd: number;
  all: boolean;
  tooLarge: boolean;
}

export type FoldOpenings = Readonly<Record<string, FoldOpening>>;

interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface FoldGap {
  id: string;
  oldStart: number;
  oldEnd: number;
  hasStart: boolean;
  hasEnd: boolean;
  delta: number;
}

const hiddenLineLimit = 100_000;
const foldRevealCount = 3;

export function foldInlineDiff(
  diffText: string,
  sides: FoldSides,
  openings: FoldOpenings = {},
  options: DiffLinesOptions = {},
): FoldedDiff {
  const diff = diffLines(diffText, options);
  const hunks = hunkRanges(diffText);
  const counts = hunkLineCounts(diffText);
  const oldLines = splitFileLines(sides.oldText);
  const gaps = foldGaps(hunks, oldLines.length);
  const rows: FoldedRow[] = [];
  let cursor = 0;
  const leading = gaps.find((gap) => !gap.hasStart && gap.hasEnd);
  if (leading) {
    rows.push(...rowsForGap(leading, openings[leading.id], oldLines));
  }
  for (let index = 0; index < hunks.length; index += 1) {
    const count = counts[index] ?? 0;
    for (const line of diff.lines.slice(cursor, cursor + count)) {
      rows.push({ kind: 'line', line });
    }
    cursor += count;
    if (index < hunks.length - 1) {
      const previous = hunks[index];
      const next = hunks[index + 1];
      if (previous && next) {
        const middle = gaps.find((gap) => gap.oldStart === previousLast(previous) + 1 && gap.hasStart && gap.hasEnd);
        if (middle) {
          rows.push(...rowsForGap(middle, openings[middle.id], oldLines));
        }
      }
    }
  }
  if (cursor < diff.lines.length) {
    for (const line of diff.lines.slice(cursor)) {
      rows.push({ kind: 'line', line });
    }
  }
  const trailing = gaps.find((gap) => gap.hasStart && !gap.hasEnd);
  if (trailing) {
    rows.push(...rowsForGap(trailing, openings[trailing.id], oldLines));
  }
  return { rows, previousPath: diff.previousPath, binary: diff.binary };
}

export function openFoldMore(openings: FoldOpenings, fold: FoldedFoldRow): FoldOpenings {
  const current = openings[fold.id] ?? { fromStart: 0, fromEnd: 0, all: false, tooLarge: false };
  const reveal = (fold.hasStart ? foldRevealCount : 0) + (fold.hasEnd ? foldRevealCount : 0);
  if (fold.hidden <= reveal) {
    return { ...openings, [fold.id]: { ...current, all: true, tooLarge: false } };
  }
  const nextHidden = fold.hidden - reveal;
  return {
    ...openings,
    [fold.id]: {
      fromStart: current.fromStart + (fold.hasStart ? foldRevealCount : 0),
      fromEnd: current.fromEnd + (fold.hasEnd ? foldRevealCount : 0),
      all: false,
      tooLarge: current.tooLarge && nextHidden > hiddenLineLimit,
    },
  };
}

export function openFoldAll(openings: FoldOpenings, fold: FoldedFoldRow): FoldOpenings {
  const current = openings[fold.id] ?? { fromStart: 0, fromEnd: 0, all: false, tooLarge: false };
  if (fold.hidden > hiddenLineLimit) {
    return { ...openings, [fold.id]: { ...current, tooLarge: true } };
  }
  return { ...openings, [fold.id]: { ...current, all: true, tooLarge: false } };
}

function rowsForGap(gap: FoldGap, opening: FoldOpening | undefined, oldLines: string[]): FoldedRow[] {
  const total = gap.oldEnd - gap.oldStart + 1;
  const state = opening ?? { fromStart: 0, fromEnd: 0, all: false, tooLarge: false };
  if (state.all) {
    return rangeLines(gap.oldStart, gap.oldEnd, gap.delta, oldLines).map((line) => ({ kind: 'line', line }));
  }
  const fromStart = gap.hasStart ? Math.min(state.fromStart, total) : 0;
  const fromEnd = gap.hasEnd ? Math.min(state.fromEnd, Math.max(0, total - fromStart)) : 0;
  const hiddenStart = gap.oldStart + fromStart;
  const hiddenEnd = gap.oldEnd - fromEnd;
  const hidden = hiddenEnd - hiddenStart + 1;
  if (hidden <= 0) {
    return rangeLines(gap.oldStart, gap.oldEnd, gap.delta, oldLines).map((line) => ({ kind: 'line', line }));
  }
  const rows: FoldedRow[] = rangeLines(gap.oldStart, hiddenStart - 1, gap.delta, oldLines).map((line) => ({
    kind: 'line',
    line,
  }));
  rows.push({
    kind: 'fold',
    id: gap.id,
    hidden,
    label: hidden === 1 ? '1 hidden line' : `${hidden} hidden lines`,
    tooLarge: state.tooLarge,
    hasStart: gap.hasStart,
    hasEnd: gap.hasEnd,
  });
  rows.push(...rangeLines(hiddenEnd + 1, gap.oldEnd, gap.delta, oldLines).map((line) => ({ kind: 'line' as const, line })));
  return rows;
}

function rangeLines(start: number, end: number, delta: number, oldLines: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (let oldNumber = start; oldNumber <= end; oldNumber += 1) {
    const newNumber = oldNumber + delta;
    const text = oldLines[oldNumber - 1] ?? '';
    lines.push({
      kind: 'context',
      oldNumber,
      newNumber,
      text,
      spans: [{ text, changed: false }],
    });
  }
  return lines;
}

function foldGaps(hunks: HunkRange[], oldLineCount: number): FoldGap[] {
  const first = hunks[0];
  if (!first) {
    return [];
  }
  const gaps: FoldGap[] = [];
  const firstOld = first.oldCount === 0 ? first.oldStart + 1 : first.oldStart;
  if (firstOld > 1) {
    gaps.push({
      id: `1-${firstOld - 1}`,
      oldStart: 1,
      oldEnd: firstOld - 1,
      hasStart: false,
      hasEnd: true,
      delta: 0,
    });
  }
  let delta = first.newCount - first.oldCount;
  for (let index = 0; index < hunks.length - 1; index += 1) {
    const previous = hunks[index];
    const next = hunks[index + 1];
    if (!previous || !next) {
      continue;
    }
    const lastOld = previousLast(previous);
    const nextOld = next.oldCount === 0 ? next.oldStart + 1 : next.oldStart;
    if (nextOld > lastOld + 1) {
      gaps.push({
        id: `${lastOld + 1}-${nextOld - 1}`,
        oldStart: lastOld + 1,
        oldEnd: nextOld - 1,
        hasStart: true,
        hasEnd: true,
        delta,
      });
    }
    delta += next.newCount - next.oldCount;
  }
  const last = hunks[hunks.length - 1];
  if (!last) {
    return gaps;
  }
  const lastOld = previousLast(last);
  if (oldLineCount > lastOld) {
    gaps.push({
      id: `${lastOld + 1}-${oldLineCount}`,
      oldStart: lastOld + 1,
      oldEnd: oldLineCount,
      hasStart: true,
      hasEnd: false,
      delta,
    });
  }
  return gaps;
}

function previousLast(hunk: HunkRange): number {
  return hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldCount - 1;
}

function hunkRanges(diffText: string): HunkRange[] {
  const hunks: HunkRange[] = [];
  for (const line of diffText.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!header) {
      continue;
    }
    hunks.push({
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
    });
  }
  return hunks;
}

function hunkLineCounts(diffText: string): number[] {
  const counts: number[] = [];
  let current = -1;
  for (const line of diffText.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('@@')) {
      counts.push(0);
      current = counts.length - 1;
      continue;
    }
    if (current < 0 || line.startsWith('\\')) {
      continue;
    }
    const marker = line[0];
    if (marker === ' ' || marker === '-' || marker === '+') {
      counts[current] = (counts[current] ?? 0) + 1;
    }
  }
  return counts;
}

function splitFileLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export const fullFileByteLimit = 2 * 1024 * 1024;
const fullFileLineLimit = 100_000;

export interface FullFileDiff {
  lines: DiffLine[];
  tooLarge: boolean;
}

export function fullFileLines(diffText: string, oldText: string, newText: string): FullFileDiff {
  if (sideTooLarge(oldText) || sideTooLarge(newText)) {
    return { lines: [], tooLarge: true };
  }
  const oldLines = gitLines(oldText);
  const newLines = gitLines(newText);
  const hasOldFile = !/^--- \/dev\/null$/m.test(diffText) && !/@@ -0,0 /.test(diffText);
  const result: DiffLine[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  for (const line of diffLines(diffText).lines) {
    if (line.oldNumber !== null && line.oldNumber > oldCursor) {
      emitUnchanged(result, oldLines, newLines, oldCursor, newCursor, line.oldNumber);
      const gap = line.oldNumber - oldCursor;
      oldCursor = line.oldNumber;
      newCursor += gap;
    } else if (line.oldNumber === null && line.newNumber !== null && line.newNumber > newCursor) {
      const gap = line.newNumber - newCursor;
      emitUnchanged(result, oldLines, newLines, oldCursor, newCursor, oldCursor + gap);
      oldCursor += gap;
      newCursor = line.newNumber;
    }
    result.push(line);
    if (line.oldNumber !== null) {
      oldCursor = line.oldNumber + 1;
    }
    if (line.newNumber !== null) {
      newCursor = line.newNumber + 1;
    }
  }
  if (hasOldFile && oldCursor <= oldLines.length) {
    emitUnchanged(result, oldLines, newLines, oldCursor, newCursor, oldLines.length + 1);
  }
  return { lines: result, tooLarge: false };
}

function sideTooLarge(text: string): boolean {
  if (Buffer.byteLength(text) > fullFileByteLimit) {
    return true;
  }
  return gitLines(text).length > fullFileLineLimit;
}

function gitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function emitUnchanged(
  result: DiffLine[],
  oldLines: string[],
  newLines: string[],
  oldCursor: number,
  newCursor: number,
  untilOld: number,
): void {
  let oldNumber = oldCursor;
  let newNumber = newCursor;
  while (oldNumber < untilOld) {
    const text = oldLines[oldNumber - 1] ?? newLines[newNumber - 1] ?? '';
    result.push({
      kind: 'context',
      oldNumber,
      newNumber,
      text,
      spans: [{ text, changed: false }],
    });
    oldNumber += 1;
    newNumber += 1;
  }
}

export interface SideCell {
  kind: 'context' | 'removed' | 'added' | 'empty';
  number: number | null;
  text: string;
  spans: DiffSpan[];
}

export interface SideBySideLineRow {
  kind: 'line';
  old: SideCell;
  new: SideCell;
}

export type SideBySideRow = SideBySideLineRow | FoldedFoldRow;

const emptySideCell: SideCell = { kind: 'empty', number: null, text: '', spans: [] };

export function sideBySideRows(rows: readonly FoldedRow[]): SideBySideRow[] {
  const paired: SideBySideRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) {
      break;
    }
    if (row.kind === 'fold') {
      paired.push(row);
      index += 1;
      continue;
    }
    if (row.line.kind === 'context') {
      paired.push(contextSideRow(row.line));
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    while (index < rows.length) {
      const current = rows[index];
      if (!current || current.kind !== 'line' || current.line.kind !== 'removed') {
        break;
      }
      removed.push(current.line);
      index += 1;
    }
    const added: DiffLine[] = [];
    while (index < rows.length) {
      const current = rows[index];
      if (!current || current.kind !== 'line' || current.line.kind !== 'added') {
        break;
      }
      added.push(current.line);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let pair = 0; pair < count; pair += 1) {
      const oldLine = removed[pair];
      const newLine = added[pair];
      paired.push({
        kind: 'line',
        old: oldLine ? sideCell('removed', oldLine.oldNumber, oldLine) : emptySideCell,
        new: newLine ? sideCell('added', newLine.newNumber, newLine) : emptySideCell,
      });
    }
  }
  return paired;
}

function contextSideRow(line: DiffLine): SideBySideLineRow {
  return {
    kind: 'line',
    old: sideCell('context', line.oldNumber, line),
    new: sideCell('context', line.newNumber, line),
  };
}

function sideCell(kind: 'context' | 'removed' | 'added', number: number | null, line: DiffLine): SideCell {
  return { kind, number, text: line.text, spans: line.spans };
}

function coalesce(tokens: string[], changed: boolean[]): DiffSpan[] {
  const spans: DiffSpan[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index] ?? '';
    const isChanged = changed[index] ?? false;
    const last = spans.at(-1);
    if (last && last.changed === isChanged) {
      last.text += text;
      continue;
    }
    spans.push({ text, changed: isChanged });
  }
  if (spans.length === 0) {
    spans.push({ text: '', changed: false });
  }
  return spans;
}
