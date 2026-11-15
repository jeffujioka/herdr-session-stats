// How the card list adapts to the container the mod sits in. Pure and runtime-neutral: the mod
// passes in what herdr says of its container and draws what this returns, so the choice is
// tested without the app.
//
// `container.placement` is herdr's `placement()`: `{ edge, align, vertical, hovered, dragging }`
// for a mod that floats, and null for one in a layout block (the docked column). herdr's rule
// for a floating mod is to lay out vertically when `vertical` (a left or right edge) and
// horizontally otherwise; a block in a layout is a side column, so its cards stack too.
//
// A floating mod on a side edge is the drawer: each card is a compact row, whose key figures sit
// on the edge side (that is what shows while the drawer peeks), so on the right edge the row is
// mirrored. The choice ignores `hovered` and `dragging`: the app slides the drawer open, the
// mod draws one layout.
//
// `overlay` is `props().overlay`, the id herdr gives a mod it opened as an overlay (a popup the
// mod.json sizes larger than the default). The overlay is neither docked nor a drawer: the cards
// stack as full cards, and `roomy` (set only then) tells the mod to use the extra room.
//
// The drawer's content has a fixed width, `DRAWER_WIDTH_PX`: a floating block sizes to its
// content, so a row as wide as its longest folder path would make the expanded drawer cover the
// window. The rows truncate their text to it.
//
// Returns `{ direction: 'vertical' | 'horizontal', compact, mirror }`, `width` (px, set only for
// the drawer) and `roomy: true` in an overlay: the way the cards are listed, whether each is a
// compact row, whether the row is mirrored, the drawer's fixed width, and whether the full card
// spreads over the room of an overlay.
export const DRAWER_WIDTH_PX = 360;

export function adapt({ placement = null, overlay = null } = {}) {
  if (overlay) return { direction: 'vertical', compact: false, mirror: false, roomy: true };
  const compact = Boolean(placement?.vertical);
  return {
    direction: placement && !placement.vertical ? 'horizontal' : 'vertical',
    compact,
    mirror: compact && placement.edge === 'right',
    ...(compact ? { width: DRAWER_WIDTH_PX } : {}),
  };
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
