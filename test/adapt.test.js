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
});
