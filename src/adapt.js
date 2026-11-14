// How the card list adapts to the container the mod sits in. Pure and runtime-neutral: the mod
// passes in what herdr says of its container and draws what this returns, so the choice is
// tested without the app.
//
// `container.placement` is herdr's `placement()`: `{ edge, align, vertical, hovered, dragging }`
// for a mod that floats, and null for one in a layout block (the docked column). herdr's rule
// for a floating mod is to lay out vertically when `vertical` (a left or right edge) and
// horizontally otherwise; a block in a layout is a side column, so its cards stack too.
// Returns `{ direction: 'vertical' | 'horizontal' }`: the way the cards are listed.
export function adapt({ placement = null } = {}) {
  return { direction: placement && !placement.vertical ? 'horizontal' : 'vertical' };
}
