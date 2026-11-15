// herdr-session-stats: one card per agent pane with its folder, git state and session stats.
// The data work is in cards.js (copied here from src/ by scripts/sync.sh); this file wires
// herdr's live data, `exec` and timers to it and draws the result.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, nextCommand, panes, placement, props, readTextFile, spaces, theme } from "herdr";
import { adapt, drawerHidden, nextDrawerState } from "./adapt.js";
import { agentPanes, createCardBuilder, panesOfActiveSpace } from "./cards.js";
import { describeCard, formatCost, formatPercent } from "./format.js";
import { REFRESH_INTERVAL_MS } from "./refresh.js";

// The panes of the shown space as `panes()` reports them, each with the machine of its space:
// the pane's tab names the space it is in, and the space the machine.
function livePanes() {
  const all = spaces();
  const machineOfTab = new Map(all.flatMap((space) => space.tabs.map((tab) => [tab.id, space.machine])));
  return panesOfActiveSpace(panes(), all).map((pane) => ({ ...pane, machine: machineOfTab.get(pane.tab) ?? null }));
}

// A full card. `roomy` is the overlay's: the same figures in larger type, the rows in two
// columns, so the card uses the room of the larger dialog. `strip` is the drawer's
// (`{ side, px }`, src/adapt.js): the header row carries the key figures (context used, cost)
// in a column of `px` on the edge side, and the rows below stop before it, so a peeking drawer
// shows a column of key figures and an open one the whole card.
function card(c, t, { roomy = false, strip = null } = {}) {
  const { title, place, rows } = describeCard(c);
  const [folder, ...git] = place;
  const [titleSize, placeSize, rowSize] = roomy ? [18, 14, 14] : [13, 11, 12];
  const heading = [
    div().text_size(titleSize).font_semibold().text_color(t.foreground).truncate().child(title),
    div().text_size(placeSize).text_color(t.muted).truncate().child(folder ?? "n/a"),
  ];
  const details = [
    ...git.map((line) => div().text_size(placeSize).text_color(t.dim).truncate().child(line)),
    (roomy ? h_flex().flex_wrap() : v_flex().gap(1))
      .pt(roomy ? 10 : 6)
      .children(
        rows.map(([label, value]) =>
          h_flex()
            .justify_between()
            .gap(8)
            .text_size(rowSize)
            .when(roomy, (el) => el.w_1_2().px(8).py(2))
            .child(div().flex_none().text_color(t.dim).child(label))
            .child(div().truncate().text_color(value === "n/a" ? t.dim : t.foreground).child(value)),
        ),
      ),
  ];
  const shell = v_flex().id(`card-${c.id}`).gap(2).bg(t.surface).border_color(t.border);
  if (!strip) return shell.p(roomy ? 14 : 10).rounded(6).border(1).children([...heading, ...details]);

  const onRight = strip.side === "right";
  const figure = (text, size, color) => div().text_size(size).text_color(text === "n/a" ? t.dim : color).child(text);
  return shell
    .border_b(1)
    .child(
      h_flex()
        .items_start()
        .when(!onRight, (el) => el.flex_row_reverse())
        .child(v_flex().flex_1().min_w_0().gap(2).p(10).children(heading))
        .child(
          v_flex()
            .flex_none()
            .w(strip.px)
            .items_center()
            .py(10)
            .child(figure(formatPercent(c.stats.contextPercent), 13, t.foreground).font_semibold())
            .child(figure(formatCost(c.stats.costUsd), 11, t.muted)),
        ),
    )
    .child(
      (onRight ? v_flex().gap(2).pl(10).pr(strip.px) : v_flex().gap(2).pr(10).pl(strip.px)).pb(10).children(details),
    );
}

export default class SessionStats extends View {
  init(_props, cx) {
    this.cards = [];
    this.agents = null; // agent panes at the last tick, null before the first
    this.problem = null;
    this.lastError = null;
    // whether this copy floats (it is the drawer) does not change for its lifetime; the drawer
    // starts hidden, and the state is this copy's own, so a restart or a layout switch hides it
    this.floats = placement() !== null;
    this.shown = false;
    this.builder = createCardBuilder({ exec, readTextFile, home: home() });
    cx.timer.every(REFRESH_INTERVAL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
    this.listen(cx);
  }

  // The key commands of this mod. The drawer's key (`herdr-session-stats.drawer`) is delivered
  // to every shown copy; only the copy that floats, the drawer, reacts (src/adapt.js).
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.shown = nextDrawerState(command, this.floats, this.shown);
        cx.notify();
      }
    });
  }

  // Every tick starts a refresh. A card shows as soon as its own pane is resolved, so a slow
  // machine holds back only its own cards; the builder does not restart a pane that an earlier
  // refresh is still resolving, and a call that starts nothing resolves at once (the cards
  // arrive through the call that started the pane).
  refresh(cx) {
    cx.spawn(async (cx) => {
      let panes;
      try {
        panes = livePanes();
      } catch (error) {
        // once per distinct failure, not at every tick
        const message = String(error?.message ?? error);
        if (message !== this.lastError) console.log(`herdr-session-stats: cannot read panes: ${message}`);
        this.lastError = message;
        this.problem = "Cannot read panes";
        cx.notify();
        return;
      }
      this.lastError = null;
      this.problem = null;
      this.agents = agentPanes(panes).length;
      await this.builder.build(panes, Date.now(), (cards) => {
        this.cards = cards;
        cx.notify();
      });
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const floating = placement();
    // The drawer is the copy that floats. It starts hidden and draws nothing until its key's
    // command shows it (src/adapt.js).
    if (drawerHidden(this.floats, this.shown)) return div();
    // No card yet is "No agents" only when herdr reports no agent pane; with agent panes it is
    // loading, however long a slow machine takes.
    const empty = this.agents === 0 ? "No agents" : "Loading…";
    const note = this.problem ?? (this.cards.length === 0 ? empty : null);
    // The container decides how the cards are listed: a column or a side edge stacks them, a
    // top or bottom edge puts them side by side, a drawer on a side edge draws the full card in
    // a fixed width with a strip for the key figures on the edge side (mirrored on the right
    // edge), and the overlay draws the full card roomy (src/adapt.js).
    const { direction, roomy, width, strip } = adapt({ placement: floating, overlay: props()?.overlay });
    const vertical = direction === "vertical";
    const list = vertical
      ? v_flex().overflow_y_scrollbar()
      : h_flex().items_start().overflow_x_scrollbar();
    return list
      .id("session-stats")
      .when(width === undefined, (el) => el.size_full())
      .when(width !== undefined, (el) => el.w(width))
      .gap(strip ? 0 : 8)
      .p(strip ? 0 : 8)
      .bg(t.chrome)
      .children(
        this.cards.map((c) =>
          vertical ? card(c, t, { roomy, strip: strip ?? null }) : div().flex_none().w(260).child(card(c, t)),
        ),
      )
      .when(note !== null, (el) => el.child(div().text_size(12).text_color(t.dim).child(note)));
  }
}
