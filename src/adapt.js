// How the card list adapts to the container the mod sits in. Pure and runtime-neutral: the mod
// passes in what herdr says of its container and draws what this returns, so the choice is
// tested without the app.
//
// `container.placement` is herdr's `placement()`: `{ edge, align, vertical, hovered, dragging }`
// for a mod that floats, and null for one in a layout block (the docked column). herdr's rule
// for a floating mod is to lay out vertically when `vertical` (a left or right edge) and
// horizontally otherwise; a block in a layout is a side column, so its cards stack too.
//
// `overlay` is `props().overlay`, the id herdr gives a mod it opened as an overlay (a popup the
// mod.json sizes larger than the default). The overlay is not docked: the cards stack as full
// cards, and `roomy` (set only then) tells the mod to use the extra room.
//
// Returns `{ direction: 'vertical' | 'horizontal' }`, and `roomy: true` in an overlay.
export function adapt({ placement = null, overlay = null } = {}) {
  if (overlay) return { direction: 'vertical', roomy: true };
  return { direction: placement && !placement.vertical ? 'horizontal' : 'vertical' };
}
