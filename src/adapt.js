// How the card list adapts to the container the mod sits in. Pure and runtime-neutral: the mod
// passes in what herdr says of its container and draws what this returns, so the choice is
// tested without the app.
//
// `container.placement` is herdr's `placement()`: `{ edge, align, vertical, hovered, dragging }`
// for a mod that floats, and null for one in a layout block (the docked column). herdr's rule
// for a floating mod is to lay out vertically when `vertical` (a left or right edge) and
// horizontally otherwise; a block in a layout is a side column, so its cards stack too.
//
// A floating mod on a side edge is the drawer: it draws the full card, in a fixed width, with a
// strip of `DRAWER_PEEK_PX` reserved on the edge side. The card's header row carries the key
// figures in that strip, and the figure rows stop before it, so what shows while the drawer
// peeks is a clean column of key figures per card, and the open drawer shows everything. On the
// right edge the strip is on the right. The choice ignores `hovered` and `dragging`: the app
// slides the drawer open, the mod draws one layout.
//
// `overlay` is `props().overlay`, the id herdr gives a mod it opened as an overlay (a popup the
// mod.json sizes larger than the default). The overlay is neither docked nor a drawer: the cards
// stack as full cards, and `roomy` (set only then) tells the mod to use the extra room.
//
// The drawer's content has a fixed width, `DRAWER_WIDTH_PX`: a floating block sizes to its
// content, so a card as wide as its longest folder path would make the expanded drawer cover
// the window. The card truncates its text to it.
//
// Returns `{ direction: 'vertical' | 'horizontal' }`, and for the drawer `width` (px) and
// `strip: { side: 'left' | 'right', px }` (the key figures' column on the edge side), and
// `roomy: true` in an overlay: the way the cards are listed, the drawer's fixed width and
// strip, and whether the full card spreads over the room of an overlay.
export const DRAWER_WIDTH_PX = 360;

// How much of the drawer shows until it is hovered (the `peek` of its floating block, which
// the install sets from this) and so the width of the strip of key figures.
export const DRAWER_PEEK_PX = 72;

export function adapt({ placement = null, overlay = null } = {}) {
  if (overlay) return { direction: 'vertical', roomy: true };
  if (placement?.vertical) {
    return {
      direction: 'vertical',
      width: DRAWER_WIDTH_PX,
      strip: { side: placement.edge === 'right' ? 'right' : 'left', px: DRAWER_PEEK_PX },
    };
  }
  return { direction: placement ? 'horizontal' : 'vertical' };
}

// The drawer's key is bound to the mod's own command, `<mod>.drawer` (herdr's `layout.toggle`
// cannot find a floating block), which herdr delivers to `nextCommand()` of every shown copy.
export const DRAWER_COMMAND = 'drawer';

// Whether the drawer is shown after `command`: `floating` is whether this copy floats (it is
// the drawer), `shown` whether it is shown now. Only the floating copy reacts to the command,
// so the copies that hear it all flip nothing but the drawer, once.
export function nextDrawerState(command, floating, shown) {
  return command === DRAWER_COMMAND && floating ? !shown : shown;
}

// The drawer starts hidden and draws nothing (AGENTS.md: a floating block sizes to its content,
// so rendering nothing hides it) until the command shows it. A copy that does not float is
// never hidden.
export function drawerHidden(floating, shown) {
  return floating && !shown;
}
