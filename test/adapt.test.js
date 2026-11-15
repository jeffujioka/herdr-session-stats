import { describe, expect, test } from 'bun:test';
import { adapt, DRAWER_COMMAND, DRAWER_PEEK_PX, DRAWER_WIDTH_PX, drawerHidden, nextDrawerState } from '../src/adapt.js';

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

  test('drawer placement is the full card', () => {
    // the drawer floats on a side edge: the full card, listed vertically, with a strip of the
    // peek's width reserved on the edge side for the key figures (so on the right edge the strip
    // is on the right); the drawer has a fixed width, so a long folder path never makes it grow
    expect(DRAWER_WIDTH_PX).toBe(360);
    expect(DRAWER_PEEK_PX).toBe(72);
    expect(adapt({ placement: floating('right') })).toEqual({
      direction: 'vertical',
      width: DRAWER_WIDTH_PX,
      strip: { side: 'right', px: DRAWER_PEEK_PX },
    });
    expect(adapt({ placement: floating('left') })).toEqual({
      direction: 'vertical',
      width: DRAWER_WIDTH_PX,
      strip: { side: 'left', px: DRAWER_PEEK_PX },
    });
    // the other containers have no fixed width and no strip: the dock and the overlay are unchanged
    for (const placement of [null, floating('top'), floating('bottom')]) {
      expect(adapt({ placement }).width).toBeUndefined();
      expect(adapt({ placement }).strip).toBeUndefined();
    }
    expect(adapt({ placement: null })).toEqual({ direction: 'vertical' });
    expect(adapt({ placement: floating('top') })).toEqual({ direction: 'horizontal' });
    expect(adapt({ overlay: 'o1' })).toEqual({ direction: 'vertical', roomy: true });
    // the drawing never changes on hover: the app slides the drawer open, the mod draws one layout
    expect(adapt({ placement: floating('right', { hovered: true, dragging: true }) })).toEqual(adapt({ placement: floating('right') }));

    // the drawer's key sends the command `drawer`, and only the copy that floats reacts, so
    // several copies hearing it never flip it twice; it starts hidden and draws nothing then
    expect(DRAWER_COMMAND).toBe('drawer');
    expect(drawerHidden(true, false)).toBe(true);
    expect(nextDrawerState(DRAWER_COMMAND, true, false)).toBe(true);
    expect(drawerHidden(true, true)).toBe(false);
    expect(nextDrawerState(DRAWER_COMMAND, true, true)).toBe(false);
    // the dock and the overlay do not float: they ignore the command and are never hidden by it
    expect(nextDrawerState(DRAWER_COMMAND, false, false)).toBe(false);
    expect(drawerHidden(false, false)).toBe(false);
    // another command changes nothing
    expect(nextDrawerState('focus', true, true)).toBe(true);
    expect(nextDrawerState('focus', true, false)).toBe(false);
  });

  test('a docked column and a top or bottom edge keep the full card without a strip', () => {
    for (const placement of [null, floating('top'), floating('bottom')]) {
      expect(adapt({ placement })).not.toHaveProperty('strip');
    }
    expect(adapt({})).not.toHaveProperty('strip');
  });
});
