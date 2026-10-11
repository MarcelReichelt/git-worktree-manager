import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/diff-lines';

describe('diffLines', () => {
  it('reads a one-word change with old and new numbers and marks that word', () => {
    const diffText = [
      'diff --git a/notes.txt b/notes.txt',
      'index 111..222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,3 +1,3 @@',
      ' hello world',
      '-hello world',
      '+hello there',
      ' hello world',
      '',
    ].join('\n');

    expect(diffLines(diffText)).toEqual({
      previousPath: null,
      binary: false,
      lines: [
        {
          kind: 'context',
          oldNumber: 1,
          newNumber: 1,
          text: 'hello world',
          spans: [{ text: 'hello world', changed: false }],
        },
        {
          kind: 'removed',
          oldNumber: 2,
          newNumber: null,
          text: 'hello world',
          spans: [
            { text: 'hello ', changed: false },
            { text: 'world', changed: true },
          ],
        },
        {
          kind: 'added',
          oldNumber: null,
          newNumber: 2,
          text: 'hello there',
          spans: [
            { text: 'hello ', changed: false },
            { text: 'there', changed: true },
          ],
        },
        {
          kind: 'context',
          oldNumber: 3,
          newNumber: 3,
          text: 'hello world',
          spans: [{ text: 'hello world', changed: false }],
        },
      ],
    });
  });

  it('marks a whitespace-only change as a removed line and an added line', () => {
    const diffText = ['@@ -1 +1 @@', '-hello world', '+hello  world', ''].join('\n');

    expect(diffLines(diffText).lines).toEqual([
      {
        kind: 'removed',
        oldNumber: 1,
        newNumber: null,
        text: 'hello world',
        spans: [
          { text: 'hello', changed: false },
          { text: ' ', changed: true },
          { text: 'world', changed: false },
        ],
      },
      {
        kind: 'added',
        oldNumber: null,
        newNumber: 1,
        text: 'hello  world',
        spans: [
          { text: 'hello', changed: false },
          { text: '  ', changed: true },
          { text: 'world', changed: false },
        ],
      },
    ]);
  });

  it('reads a new file as added lines with no old numbers', () => {
    const diffText = ['--- /dev/null', '+++ b/notes.txt', '@@ -0,0 +1,2 @@', '+alpha', '+beta', ''].join('\n');

    expect(diffLines(diffText).lines).toEqual([
      {
        kind: 'added',
        oldNumber: null,
        newNumber: 1,
        text: 'alpha',
        spans: [{ text: 'alpha', changed: false }],
      },
      {
        kind: 'added',
        oldNumber: null,
        newNumber: 2,
        text: 'beta',
        spans: [{ text: 'beta', changed: false }],
      },
    ]);
  });

  it('reads a deleted file as removed lines with no new numbers', () => {
    const diffText = ['--- a/notes.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-alpha', '-beta', ''].join('\n');

    expect(diffLines(diffText).lines).toEqual([
      {
        kind: 'removed',
        oldNumber: 1,
        newNumber: null,
        text: 'alpha',
        spans: [{ text: 'alpha', changed: false }],
      },
      {
        kind: 'removed',
        oldNumber: 2,
        newNumber: null,
        text: 'beta',
        spans: [{ text: 'beta', changed: false }],
      },
    ]);
  });

  it('reads only the hunk lines and drops the no-newline marker', () => {
    const diffText = [
      '@@ -1,5 +1,5 @@',
      ' one',
      ' two',
      ' three',
      '-four',
      '+four!',
      ' five',
      '\\ No newline at end of file',
      '@@ -20,3 +20,3 @@',
      ' twenty',
      '-old',
      '+new',
      ' twenty-two',
      '',
    ].join('\n');

    expect(diffLines(diffText).lines.map((line) => line.text)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'four!',
      'five',
      'twenty',
      'old',
      'new',
      'twenty-two',
    ]);
  });

  it('leaves a block that is not a one-for-one replacement unmarked inside the line', () => {
    const diffText = ['@@ -1,2 +1 @@', '-alpha', '-beta', '+gamma', ''].join('\n');

    expect(diffLines(diffText).lines).toEqual([
      {
        kind: 'removed',
        oldNumber: 1,
        newNumber: null,
        text: 'alpha',
        spans: [{ text: 'alpha', changed: false }],
      },
      {
        kind: 'removed',
        oldNumber: 2,
        newNumber: null,
        text: 'beta',
        spans: [{ text: 'beta', changed: false }],
      },
      {
        kind: 'added',
        oldNumber: null,
        newNumber: 1,
        text: 'gamma',
        spans: [{ text: 'gamma', changed: false }],
      },
    ]);
  });

  it('reads Renamed from the diff and still returns the changed lines', () => {
    const diffText = [
      'diff --git a/docs/old-guide.md b/docs/guide.md',
      'similarity index 90%',
      'rename from docs/old-guide.md',
      'rename to docs/guide.md',
      '--- a/docs/old-guide.md',
      '+++ b/docs/guide.md',
      '@@ -2,3 +2,3 @@',
      ' harbor notes',
      '-old guide',
      '+new guide',
      ' keep the rest',
      '',
    ].join('\n');

    const diff = diffLines(diffText);
    expect(diff.previousPath).toBe('docs/old-guide.md');
    expect(diff.binary).toBe(false);
    expect(diff.lines.map((line) => line.text)).toEqual(['harbor notes', 'old guide', 'new guide', 'keep the rest']);
    expect(diff.lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [2, 2],
      [3, null],
      [null, 3],
      [4, 4],
    ]);
  });

  it('uses the selected previous path when the diff has no rename', () => {
    const diff = diffLines('@@ -1 +1 @@\n-old guide\n+new guide\n', { previousPath: 'docs/old-guide.md' });

    expect(diff.previousPath).toBe('docs/old-guide.md');
    expect(diff.lines.map((line) => line.text)).toEqual(['old guide', 'new guide']);
  });

  it('reads a pure rename as the old path and no lines', () => {
    const diffText = ['similarity index 100%', 'rename from docs/old-guide.md', 'rename to docs/guide.md', ''].join('\n');

    expect(diffLines(diffText)).toEqual({
      previousPath: 'docs/old-guide.md',
      binary: false,
      lines: [],
    });
  });

  it('does not pair a removed line with an added line from another hunk', () => {
    const diffText = ['@@ -1 +0,0 @@', '-alpha word', '@@ -8,0 +8 @@', '+alpha other', ''].join('\n');

    expect(diffLines(diffText).lines.map((line) => line.spans)).toEqual([
      [{ text: 'alpha word', changed: false }],
      [{ text: 'alpha other', changed: false }],
    ]);
  });

  it('reads a binary diff as binary and no lines', () => {
    const diffText = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/assets/logo.png differ',
      '',
    ].join('\n');

    expect(diffLines(diffText)).toEqual({
      previousPath: null,
      binary: true,
      lines: [],
    });
  });

  it('marks the diff binary when the selected file is binary', () => {
    expect(diffLines('', { binary: true })).toEqual({
      previousPath: null,
      binary: true,
      lines: [],
    });
  });
});
