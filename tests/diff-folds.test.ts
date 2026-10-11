import { describe, expect, it } from 'vitest';
import { foldInlineDiff, openFoldAll, openFoldMore, type FoldedFoldRow, type FoldedRow } from '../src/diff-lines';

describe('foldInlineDiff', () => {
  it('places a middle fold between two changes and counts the hidden lines', () => {
    const oldText = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13', 'l14', 'l15', 'l16'].join(
      '\n',
    );
    const diffText = [
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,4 +1,4 @@',
      ' l1',
      '-l2',
      '+L2',
      ' l3',
      ' l4',
      '@@ -12,4 +12,4 @@',
      ' l12',
      '-l13',
      '+L13',
      ' l14',
      ' l15',
      '',
    ].join('\n');

    const folded = foldInlineDiff(diffText, { oldText: `${oldText}\n`, newText: `${oldText.replace('l2', 'L2').replace('l13', 'L13')}\n` });

    expect(folded.rows.map(rowText)).toEqual([
      'l1',
      '-l2',
      '+L2',
      'l3',
      'l4',
      '7 hidden lines',
      'l12',
      '-l13',
      '+L13',
      'l14',
      'l15',
      '1 hidden line',
    ]);
  });

  it('reveals three lines at each edge of a middle fold and updates the count', () => {
    const oldText = Array.from({ length: 20 }, (_, index) => `l${index + 1}`).join('\n');
    const diffText = [
      '@@ -1,4 +1,4 @@',
      ' l1',
      '-l2',
      '+L2',
      ' l3',
      ' l4',
      '@@ -15,4 +15,4 @@',
      ' l15',
      '-l16',
      '+L16',
      ' l17',
      ' l18',
      '',
    ].join('\n');
    const sides = { oldText: `${oldText}\n`, newText: `${oldText.replace('l2\n', 'L2\n').replace('l16\n', 'L16\n')}\n` };
    const closed = foldInlineDiff(diffText, sides);
    const middle = foldRow(closed.rows, '10 hidden lines');

    const opened = foldInlineDiff(diffText, sides, openFoldMore({}, middle));

    expect(opened.rows.map(rowText)).toEqual([
      'l1',
      '-l2',
      '+L2',
      'l3',
      'l4',
      'l5',
      'l6',
      'l7',
      '4 hidden lines',
      'l12',
      'l13',
      'l14',
      'l15',
      '-l16',
      '+L16',
      'l17',
      'l18',
      '2 hidden lines',
    ]);
    const rest = foldInlineDiff(diffText, sides, openFoldMore(openFoldMore({}, middle), foldRow(opened.rows, '4 hidden lines')));
    expect(rest.rows.map(rowText)).not.toContain('4 hidden lines');
    expect(rest.rows.map(rowText)).toContain('l8');
    expect(rest.rows.map(rowText)).toContain('l11');

    const revealed = opened.rows.filter((row) => row.kind === 'line' && row.line.text === 'l5');
    expect(revealed).toEqual([
      {
        kind: 'line',
        line: {
          kind: 'context',
          oldNumber: 5,
          newNumber: 5,
          text: 'l5',
          spans: [{ text: 'l5', changed: false }],
        },
      },
    ]);
  });

  it('opens a middle fold of six hidden lines completely', () => {
    const oldText = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'c1', 'c2', 'c3', 'c4'].join('\n');
    const diffText = [
      '@@ -1,4 +1,4 @@',
      ' a1',
      '-a2',
      '+A2',
      ' a3',
      ' a4',
      '@@ -11,4 +11,4 @@',
      ' c1',
      '-c2',
      '+C2',
      ' c3',
      ' c4',
      '',
    ].join('\n');
    const sides = { oldText: `${oldText}\n`, newText: `${oldText.replace('a2', 'A2').replace('c2', 'C2')}\n` };
    const closed = foldInlineDiff(diffText, sides);
    const middle = foldRow(closed.rows, '6 hidden lines');

    const opened = foldInlineDiff(diffText, sides, openFoldMore({}, middle));

    expect(opened.rows.map(rowText)).toEqual([
      'a1',
      '-a2',
      '+A2',
      'a3',
      'a4',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'c1',
      '-c2',
      '+C2',
      'c3',
      'c4',
    ]);
  });

  it('reveals three lines from the only edge of a fold at the start or the end', () => {
    const oldText = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'm1', 'm2', 'm3', 'e1', 'e2', 'e3', 'e4', 'e5'].join('\n');
    const diffText = [
      '@@ -7,5 +7,5 @@',
      ' s7',
      '-s8',
      '+S8',
      ' m1',
      ' m2',
      ' m3',
      '',
    ].join('\n');
    const sides = { oldText: `${oldText}\n`, newText: `${oldText.replace('s8', 'S8')}\n` };
    const closed = foldInlineDiff(diffText, sides);
    expect(closed.rows.map(rowText)).toEqual([
      '6 hidden lines',
      's7',
      '-s8',
      '+S8',
      'm1',
      'm2',
      'm3',
      '5 hidden lines',
    ]);

    const leading = foldInlineDiff(diffText, sides, openFoldMore({}, foldRow(closed.rows, '6 hidden lines')));
    expect(leading.rows.map(rowText)).toEqual([
      '3 hidden lines',
      's4',
      's5',
      's6',
      's7',
      '-s8',
      '+S8',
      'm1',
      'm2',
      'm3',
      '5 hidden lines',
    ]);

    const trailing = foldInlineDiff(diffText, sides, openFoldMore({}, foldRow(closed.rows, '5 hidden lines')));
    expect(trailing.rows.map(rowText)).toEqual([
      '6 hidden lines',
      's7',
      '-s8',
      '+S8',
      'm1',
      'm2',
      'm3',
      'e1',
      'e2',
      'e3',
      '2 hidden lines',
    ]);

    const shortLeadingText = ['s1', 's2', 's3', 's4', 's5', 'm1'].join('\n');
    const shortPatch = ['@@ -4,3 +4,3 @@', ' s4', '-s5', '+S5', ' m1', ''].join('\n');
    const shortSides = { oldText: `${shortLeadingText}\n`, newText: `${shortLeadingText.replace('s5', 'S5')}\n` };
    const shortClosed = foldInlineDiff(shortPatch, shortSides);
    const shortOpened = foldInlineDiff(shortPatch, shortSides, openFoldMore({}, foldRow(shortClosed.rows, '3 hidden lines')));
    expect(shortOpened.rows.map(rowText)).toEqual(['s1', 's2', 's3', 's4', '-s5', '+S5', 'm1']);
  });

  it('opens a whole stretch with All lines and numbers revealed lines on the new side', () => {
    const oldText = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const diffText = ['@@ -1,3 +1,4 @@', ' l1', '-l2', '+L2', '+extra', ' l3', ''].join('\n');
    const sides = { oldText: `${oldText}\n`, newText: 'l1\nL2\nextra\nl3\nl4\nl5\n' };
    const closed = foldInlineDiff(diffText, sides);
    expect(closed.rows.map(rowText)).toEqual(['l1', '-l2', '+L2', '+extra', 'l3', '2 hidden lines']);

    const opened = foldInlineDiff(diffText, sides, openFoldAll({}, foldRow(closed.rows, '2 hidden lines')));
    expect(opened.rows.filter((row) => row.kind === 'fold')).toEqual([]);
    expect(opened.rows.filter((row) => row.kind === 'line' && (row.line.text === 'l4' || row.line.text === 'l5'))).toEqual([
      {
        kind: 'line',
        line: {
          kind: 'context',
          oldNumber: 4,
          newNumber: 5,
          text: 'l4',
          spans: [{ text: 'l4', changed: false }],
        },
      },
      {
        kind: 'line',
        line: {
          kind: 'context',
          oldNumber: 5,
          newNumber: 6,
          text: 'l5',
          spans: [{ text: 'l5', changed: false }],
        },
      },
    ]);
  });

  it('refuses All lines on a stretch of more than 100,000 lines and still opens a smaller stretch', () => {
    const lineCount = 100015;
    const oldLines = Array.from({ length: lineCount }, (_, index) => `l${index + 1}`);
    oldLines[7] = 'before';
    const newLines = oldLines.slice();
    newLines[7] = 'after';
    const diffText = [
      '@@ -5,7 +5,7 @@',
      ' l5',
      ' l6',
      ' l7',
      '-before',
      '+after',
      ' l9',
      ' l10',
      ' l11',
      '',
    ].join('\n');
    const sides = { oldText: `${oldLines.join('\n')}\n`, newText: `${newLines.join('\n')}\n` };
    const closed = foldInlineDiff(diffText, sides);
    expect(closed.rows.map(rowText).slice(0, 9)).toEqual([
      '4 hidden lines',
      'l5',
      'l6',
      'l7',
      '-before',
      '+after',
      'l9',
      'l10',
      'l11',
    ]);
    const large = foldRow(closed.rows, '100004 hidden lines');
    expect(large.tooLarge).toBe(false);
    expect(closed.rows.map(rowText)).not.toContain('l12');
    expect(closed.rows.map(rowText)).not.toContain('l1');

    const refused = foldInlineDiff(diffText, sides, openFoldAll({}, large));
    const refusedFold = foldRow(refused.rows, '100004 hidden lines');
    expect(refusedFold.tooLarge).toBe(true);
    expect(refused.rows.map(rowText)).toContain('-before');
    expect(refused.rows.map(rowText)).toContain('+after');
    expect(refused.rows.map(rowText)).not.toContain('l12');

    const peeked = foldInlineDiff(diffText, sides, openFoldMore(openFoldAll({}, large), refusedFold));
    expect(peeked.rows.map(rowText)).toContain('l12');
    expect(peeked.rows.map(rowText)).toContain('l13');
    expect(peeked.rows.map(rowText)).toContain('l14');
    expect(peeked.rows.map(rowText)).not.toContain('l15');
    const peekedFold = peeked.rows.find((row) => row.kind === 'fold' && row.hidden === 100001);
    expect(peekedFold?.kind === 'fold' ? peekedFold.tooLarge : false).toBe(true);

    const smallOpened = foldInlineDiff(diffText, sides, openFoldAll(openFoldAll({}, large), foldRow(closed.rows, '4 hidden lines')));
    expect(smallOpened.rows.map(rowText).slice(0, 4)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(smallOpened.rows.map(rowText)).toContain('100004 hidden lines');
    expect(smallOpened.rows.map(rowText)).not.toContain('l12');
  });

  it('opens a stretch of 100,000 hidden lines and leaves a new file without a fold', () => {
    const boundary = fileWithTrailingFold(100000);
    const opened = foldInlineDiff(boundary.diffText, boundary.sides, openFoldAll({}, foldRow(foldInlineDiff(boundary.diffText, boundary.sides).rows, '100000 hidden lines')));
    expect(opened.rows.some((row) => row.kind === 'fold')).toBe(false);
    expect(opened.rows.map(rowText)).toContain('tail-1');
    expect(opened.rows.map(rowText)).toContain('tail-100000');

    const over = fileWithTrailingFold(100001);
    const refused = foldInlineDiff(over.diffText, over.sides, openFoldAll({}, foldRow(foldInlineDiff(over.diffText, over.sides).rows, '100001 hidden lines')));
    expect(foldRow(refused.rows, '100001 hidden lines').tooLarge).toBe(true);
    expect(refused.rows.map(rowText)).not.toContain('tail-1');

    const added = foldInlineDiff(['@@ -0,0 +1,2 @@', '+alpha', '+beta', ''].join('\n'), { oldText: '', newText: 'alpha\nbeta\n' });
    expect(added.rows.map(rowText)).toEqual(['+alpha', '+beta']);
  });
});

function fileWithTrailingFold(hidden: number): { diffText: string; sides: { oldText: string; newText: string } } {
  const oldLines = ['head', ...Array.from({ length: hidden }, (_, index) => `tail-${index + 1}`)];
  const newLines = ['HEAD', ...oldLines.slice(1)];
  return {
    diffText: ['@@ -1 +1 @@', '-head', '+HEAD', ''].join('\n'),
    sides: { oldText: `${oldLines.join('\n')}\n`, newText: `${newLines.join('\n')}\n` },
  };
}

function foldRow(rows: FoldedRow[], label: string): FoldedFoldRow {
  const fold = rows.find((row) => row.kind === 'fold' && row.label === label);
  if (!fold || fold.kind !== 'fold') {
    throw new Error(`missing fold ${label}`);
  }
  return fold;
}

function rowText(row: { kind: string; line?: { kind: string; text: string }; label?: string }): string {
  if (row.kind === 'fold') {
    return row.label ?? '';
  }
  const line = row.line;
  if (!line) {
    return '';
  }
  if (line.kind === 'removed') {
    return `-${line.text}`;
  }
  if (line.kind === 'added') {
    return `+${line.text}`;
  }
  return line.text;
}
