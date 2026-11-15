import { describe, expect, test } from 'bun:test';
import { adapt } from '../src/adapt.js';

// herdr's placement() for a floating mod: where it sits; null for a mod in a layout block.
const floating = (edge, extra = {}) => ({
  edge,
  align: 'center',
  vertical: edge === 'left' || edge === 'right',
  hovered: false,
  dragging: false,
  ...extra,
});

describe('adapt the card list to its container', () => {
  test('side placement is a vertical list', () => {
    // docked in a column: herdr reports no placement for a mod in a layout block
    expect(adapt({ placement: null }).direction).toBe('vertical');
    // on a side edge: herdr says `vertical`, and the cards stack
    expect(adapt({ placement: floating('right') }).direction).toBe('vertical');
    expect(adapt({ placement: floating('left', { hovered: true }) }).direction).toBe('vertical');
  });

  test('a top or bottom edge lays the cards out side by side', () => {
    expect(adapt({ placement: floating('top') }).direction).toBe('horizontal');
    expect(adapt({ placement: floating('bottom') }).direction).toBe('horizontal');
  });

  test('a mod that cannot read its placement is a vertical list', () => {
    expect(adapt({}).direction).toBe('vertical');
    expect(adapt().direction).toBe('vertical');
  });

  test('drawer placement is a compact row', () => {
    // the drawer floats on a side edge: each card is a compact row, listed vertically, with its
    // key figures on the edge side, so on the right edge the row is mirrored
    expect(adapt({ placement: floating('right') })).toEqual({ direction: 'vertical', compact: true, mirror: true });
    expect(adapt({ placement: floating('left') })).toEqual({ direction: 'vertical', compact: true, mirror: false });
    // the drawing never changes on hover: the app slides the drawer open, the mod draws one layout
    expect(adapt({ placement: floating('right', { hovered: true, dragging: true }) })).toEqual(adapt({ placement: floating('right') }));
  });

  test('a docked column and a top or bottom edge keep the full card', () => {
    for (const placement of [null, floating('top'), floating('bottom')]) {
      expect(adapt({ placement })).toMatchObject({ compact: false, mirror: false });
    }
    expect(adapt({})).toMatchObject({ compact: false, mirror: false });
  });
});
