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
// Returns `{ direction: 'vertical' | 'horizontal', compact, mirror }`, and `roomy: true` in an
// overlay: the way the cards are listed, whether each is a compact row, whether the row is
// mirrored, and whether the full card spreads over the room of an overlay.
export function adapt({ placement = null, overlay = null } = {}) {
  if (overlay) return { direction: 'vertical', compact: false, mirror: false, roomy: true };
  const compact = Boolean(placement?.vertical);
  return {
    direction: placement && !placement.vertical ? 'horizontal' : 'vertical',
    compact,
    mirror: compact && placement.edge === 'right',
  };
}
