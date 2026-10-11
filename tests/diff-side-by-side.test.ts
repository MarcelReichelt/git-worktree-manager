import { describe, expect, it } from 'vitest';
import { sideBySideRows, type FoldedRow } from '../src/diff-lines';

describe('sideBySideRows', () => {
  it('puts a context line on both sides with its old and new numbers', () => {
    const rows: FoldedRow[] = [
      {
        kind: 'line',
        line: {
          kind: 'context',
          oldNumber: 4,
          newNumber: 7,
          text: 'kept',
          spans: [{ text: 'kept', changed: false }],
        },
      },
    ];

    expect(sideBySideRows(rows)).toEqual([
      {
        kind: 'line',
        old: {
          kind: 'context',
          number: 4,
          text: 'kept',
          spans: [{ text: 'kept', changed: false }],
        },
        new: {
          kind: 'context',
          number: 7,
          text: 'kept',
          spans: [{ text: 'kept', changed: false }],
        },
      },
    ]);
  });

  it('pairs a removed line with the following added line and keeps each line’s spans', () => {
    const rows: FoldedRow[] = [
      {
        kind: 'line',
        line: {
          kind: 'removed',
          oldNumber: 2,
          newNumber: null,
          text: 'const name = "ada"',
          spans: [
            { text: 'const name = ', changed: false },
            { text: '"ada"', changed: true },
          ],
        },
      },
      {
        kind: 'line',
        line: {
          kind: 'added',
          oldNumber: null,
          newNumber: 2,
          text: 'const name = "bea"',
          spans: [
            { text: 'const name = ', changed: false },
            { text: '"bea"', changed: true },
          ],
        },
      },
    ];

    expect(sideBySideRows(rows)).toEqual([
      {
        kind: 'line',
        old: {
          kind: 'removed',
          number: 2,
          text: 'const name = "ada"',
          spans: [
            { text: 'const name = ', changed: false },
            { text: '"ada"', changed: true },
          ],
        },
        new: {
          kind: 'added',
          number: 2,
          text: 'const name = "bea"',
          spans: [
            { text: 'const name = ', changed: false },
            { text: '"bea"', changed: true },
          ],
        },
      },
    ]);
  });

  it('gives a leftover removed line an empty cell on the right', () => {
    expect(
      sideBySideRows([
        line('removed', 3, null, 'old-a'),
        line('removed', 4, null, 'old-b'),
        line('added', null, 3, 'new-a'),
      ]),
    ).toEqual([
      {
        kind: 'line',
        old: { kind: 'removed', number: 3, text: 'old-a', spans: [{ text: 'old-a', changed: false }] },
        new: { kind: 'added', number: 3, text: 'new-a', spans: [{ text: 'new-a', changed: false }] },
      },
      {
        kind: 'line',
        old: { kind: 'removed', number: 4, text: 'old-b', spans: [{ text: 'old-b', changed: false }] },
        new: { kind: 'empty', number: null, text: '', spans: [] },
      },
    ]);
  });

  it('gives a leftover added line an empty cell on the left', () => {
    expect(
      sideBySideRows([
        line('removed', 8, null, 'old'),
        line('added', null, 8, 'new-a'),
        line('added', null, 9, 'new-b'),
      ]),
    ).toEqual([
      {
        kind: 'line',
        old: { kind: 'removed', number: 8, text: 'old', spans: [{ text: 'old', changed: false }] },
        new: { kind: 'added', number: 8, text: 'new-a', spans: [{ text: 'new-a', changed: false }] },
      },
      {
        kind: 'line',
        old: { kind: 'empty', number: null, text: '', spans: [] },
        new: { kind: 'added', number: 9, text: 'new-b', spans: [{ text: 'new-b', changed: false }] },
      },
    ]);
  });

  it('leaves a new file empty on the left and a deleted file empty on the right', () => {
    expect(sideBySideRows([line('added', null, 1, 'fresh')])).toEqual([
      {
        kind: 'line',
        old: { kind: 'empty', number: null, text: '', spans: [] },
        new: { kind: 'added', number: 1, text: 'fresh', spans: [{ text: 'fresh', changed: false }] },
      },
    ]);
    expect(sideBySideRows([line('removed', 1, null, 'gone')])).toEqual([
      {
        kind: 'line',
        old: { kind: 'removed', number: 1, text: 'gone', spans: [{ text: 'gone', changed: false }] },
        new: { kind: 'empty', number: null, text: '', spans: [] },
      },
    ]);
  });

  it('keeps a fold as one row and does not pair lines across it', () => {
    const fold: FoldedRow = {
      kind: 'fold',
      id: '5-11',
      hidden: 7,
      label: '7 hidden lines',
      tooLarge: false,
      hasStart: true,
      hasEnd: true,
    };

    expect(
      sideBySideRows([
        line('context', 4, 4, 'before'),
        line('removed', 12, null, 'old'),
        fold,
        line('added', null, 13, 'new'),
      ]),
    ).toEqual([
      {
        kind: 'line',
        old: { kind: 'context', number: 4, text: 'before', spans: [{ text: 'before', changed: false }] },
        new: { kind: 'context', number: 4, text: 'before', spans: [{ text: 'before', changed: false }] },
      },
      {
        kind: 'line',
        old: { kind: 'removed', number: 12, text: 'old', spans: [{ text: 'old', changed: false }] },
        new: { kind: 'empty', number: null, text: '', spans: [] },
      },
      fold,
      {
        kind: 'line',
        old: { kind: 'empty', number: null, text: '', spans: [] },
        new: { kind: 'added', number: 13, text: 'new', spans: [{ text: 'new', changed: false }] },
      },
    ]);
  });

  it('starts a new pair after a context line', () => {
    expect(
      sideBySideRows([
        line('removed', 1, null, 'old'),
        line('context', 2, 2, 'middle'),
        line('added', null, 3, 'new'),
      ]),
    ).toEqual([
      {
        kind: 'line',
        old: { kind: 'removed', number: 1, text: 'old', spans: [{ text: 'old', changed: false }] },
        new: { kind: 'empty', number: null, text: '', spans: [] },
      },
      {
        kind: 'line',
        old: { kind: 'context', number: 2, text: 'middle', spans: [{ text: 'middle', changed: false }] },
        new: { kind: 'context', number: 2, text: 'middle', spans: [{ text: 'middle', changed: false }] },
      },
      {
        kind: 'line',
        old: { kind: 'empty', number: null, text: '', spans: [] },
        new: { kind: 'added', number: 3, text: 'new', spans: [{ text: 'new', changed: false }] },
      },
    ]);
  });
});

function line(
  kind: 'context' | 'removed' | 'added',
  oldNumber: number | null,
  newNumber: number | null,
  text: string,
): FoldedRow {
  return {
    kind: 'line',
    line: {
      kind,
      oldNumber,
      newNumber,
      text,
      spans: [{ text, changed: false }],
    },
  };
}
