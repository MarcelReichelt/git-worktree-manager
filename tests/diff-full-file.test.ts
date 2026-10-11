import { describe, expect, it } from 'vitest';
import { fullFileLines } from '../src/diff-lines';

describe('fullFileLines', () => {
  it('shows every line of a one-word change, including the stretches outside the hunk', () => {
    const diffText = [
      'diff --git a/notes.txt b/notes.txt',
      'index 111..222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -2,7 +2,7 @@',
      ' two',
      ' three',
      ' four',
      '-five',
      '+FIVE',
      ' six',
      ' seven',
      ' eight',
      '',
    ].join('\n');
    const oldText = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
    const newText = 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n';

    expect(fullFileLines(diffText, oldText, newText)).toEqual({
      tooLarge: false,
      lines: [
        context(1, 1, 'one'),
        context(2, 2, 'two'),
        context(3, 3, 'three'),
        context(4, 4, 'four'),
        {
          kind: 'removed',
          oldNumber: 5,
          newNumber: null,
          text: 'five',
          spans: [{ text: 'five', changed: true }],
        },
        {
          kind: 'added',
          oldNumber: null,
          newNumber: 5,
          text: 'FIVE',
          spans: [{ text: 'FIVE', changed: true }],
        },
        context(6, 6, 'six'),
        context(7, 7, 'seven'),
        context(8, 8, 'eight'),
        context(9, 9, 'nine'),
        context(10, 10, 'ten'),
      ],
    });
  });

  it('fills the stretch between hunks and numbers lines after an insertion', () => {
    const diffText = [
      '@@ -1,5 +1,5 @@',
      ' l01',
      '-l02',
      '+L02',
      ' l03',
      ' l04',
      ' l05',
      '@@ -15,3 +15,4 @@',
      '+INSERTED',
      ' l15',
      ' l16',
      ' l17',
      '',
    ].join('\n');
    const oldText = Array.from({ length: 20 }, (_, index) => `l${String(index + 1).padStart(2, '0')}`).join('\n');
    const newText = oldText.replace('l02', 'L02').replace('l15', 'INSERTED\nl15');

    const lines = fullFileLines(diffText, `${oldText}\n`, `${newText}\n`).lines;

    expect(lines.map((line) => line.text)).toEqual([
      'l01',
      'l02',
      'L02',
      'l03',
      'l04',
      'l05',
      'l06',
      'l07',
      'l08',
      'l09',
      'l10',
      'l11',
      'l12',
      'l13',
      'l14',
      'INSERTED',
      'l15',
      'l16',
      'l17',
      'l18',
      'l19',
      'l20',
    ]);
    expect(lines.find((line) => line.text === 'l10')).toEqual(context(10, 10, 'l10'));
    expect(lines.find((line) => line.text === 'INSERTED')).toEqual({
      kind: 'added',
      oldNumber: null,
      newNumber: 15,
      text: 'INSERTED',
      spans: [{ text: 'INSERTED', changed: false }],
    });
    expect(lines.find((line) => line.text === 'l15')).toEqual(context(15, 16, 'l15'));
    expect(lines.find((line) => line.text === 'l20')).toEqual(context(20, 21, 'l20'));
    expect(lines.find((line) => line.text === 'l02')?.spans).toEqual([{ text: 'l02', changed: true }]);
    expect(lines.find((line) => line.text === 'L02')?.spans).toEqual([{ text: 'L02', changed: true }]);
  });

  it('keeps a whitespace change marked inside the line', () => {
    const diffText = ['@@ -4 +4 @@', '-hello world', '+hello  world', ''].join('\n');
    const oldText = 'one\ntwo\nthree\nhello world\nfour\n';
    const newText = 'one\ntwo\nthree\nhello  world\nfour\n';

    const lines = fullFileLines(diffText, oldText, newText).lines;

    expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three', 'hello world', 'hello  world', 'four']);
    expect(lines[3]?.spans).toEqual([
      { text: 'hello', changed: false },
      { text: ' ', changed: true },
      { text: 'world', changed: false },
    ]);
    expect(lines[4]?.spans).toEqual([
      { text: 'hello', changed: false },
      { text: '  ', changed: true },
      { text: 'world', changed: false },
    ]);
    expect(lines[0]).toEqual(context(1, 1, 'one'));
    expect(lines[5]).toEqual(context(5, 5, 'four'));
  });

  it('does not append the previous file when the diff is a new file', () => {
    const diffText = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/guide.md',
      '@@ -0,0 +1,2 @@',
      '+alpha',
      '+beta',
      '',
    ].join('\n');

    expect(fullFileLines(diffText, 'alpha\nold line that must stay hidden\nbeta\n', 'alpha\nbeta\n').lines.map((line) => line.text)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('shows the lines around an insertion that has no context in the diff', () => {
    const diffText = ['@@ -5,0 +6,1 @@', '+INSERTED', ''].join('\n');
    const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';
    const newText = 'l1\nl2\nl3\nl4\nl5\nINSERTED\nl6\nl7\nl8\nl9\nl10\n';

    expect(fullFileLines(diffText, oldText, newText).lines.map((line) => line.text)).toEqual([
      'l1',
      'l2',
      'l3',
      'l4',
      'l5',
      'INSERTED',
      'l6',
      'l7',
      'l8',
      'l9',
      'l10',
    ]);
    expect(fullFileLines(diffText, oldText, newText).lines.find((line) => line.text === 'l10')).toEqual(context(10, 11, 'l10'));
  });

  it('shows a new file as its added lines and a deleted file as its removed lines', () => {
    const added = ['@@ -0,0 +1,2 @@', '+alpha', '+beta', ''].join('\n');
    const removed = ['@@ -1,2 +0,0 @@', '-alpha', '-beta', ''].join('\n');

    expect(fullFileLines(added, '', 'alpha\nbeta\n')).toEqual({
      tooLarge: false,
      lines: [
        { kind: 'added', oldNumber: null, newNumber: 1, text: 'alpha', spans: [{ text: 'alpha', changed: false }] },
        { kind: 'added', oldNumber: null, newNumber: 2, text: 'beta', spans: [{ text: 'beta', changed: false }] },
      ],
    });
    expect(fullFileLines(removed, 'alpha\nbeta\n', '')).toEqual({
      tooLarge: false,
      lines: [
        { kind: 'removed', oldNumber: 1, newNumber: null, text: 'alpha', spans: [{ text: 'alpha', changed: false }] },
        { kind: 'removed', oldNumber: 2, newNumber: null, text: 'beta', spans: [{ text: 'beta', changed: false }] },
      ],
    });
  });

  it('counts a final newline as no extra line and still shows a last line without one', () => {
    const diffText = ['@@ -1 +1 @@', '-one', '+ONE', ''].join('\n');

    expect(fullFileLines(diffText, 'one\ntwo', 'ONE\ntwo').lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text])).toEqual([
      ['removed', 1, null, 'one'],
      ['added', null, 1, 'ONE'],
      ['context', 2, 2, 'two'],
    ]);
    expect(fullFileLines(diffText, 'one\n', 'ONE\n').lines).toHaveLength(2);
  });

  it('refuses a side over 2 MiB or over 100,000 lines and keeps a side at either limit', () => {
    const overBytes = 'a'.repeat(2 * 1024 * 1024 + 1);
    const atBytes = 'a'.repeat(2 * 1024 * 1024);
    const overLines = 'x\n'.repeat(100_001);
    const atLines = 'x\n'.repeat(100_000);
    const oneLine = ['@@ -1 +1 @@', '-a', '+b', ''].join('\n');

    expect(fullFileLines(oneLine, overBytes, 'b')).toEqual({ lines: [], tooLarge: true });
    expect(fullFileLines(oneLine, 'a', overBytes)).toEqual({ lines: [], tooLarge: true });
    expect(fullFileLines('', '', overLines)).toEqual({ lines: [], tooLarge: true });
    expect(fullFileLines('', overLines, '')).toEqual({ lines: [], tooLarge: true });
    expect(fullFileLines(oneLine, atBytes, 'b').tooLarge).toBe(false);
    expect(fullFileLines(oneLine, atLines, 'b').tooLarge).toBe(false);
  });
});

function context(oldNumber: number, newNumber: number, text: string) {
  return {
    kind: 'context' as const,
    oldNumber,
    newNumber,
    text,
    spans: [{ text, changed: false }],
  };
}
