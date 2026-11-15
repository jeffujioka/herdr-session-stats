// herdr-session-stats: one card per agent pane with its folder, git state and session stats.
// The data work is in cards.js (copied here from src/ by scripts/sync.sh); this file wires
// herdr's live data, `exec` and timers to it and draws the result.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, panes, placement, readTextFile, spaces, theme } from "herdr";
import { adapt } from "./adapt.js";
import { agentPanes, createCardBuilder } from "./cards.js";
import { describeCard } from "./format.js";
import { REFRESH_INTERVAL_MS } from "./refresh.js";

// The panes as `panes()` reports them, each with the machine of its space: the pane's tab
// names the space it is in, and the space the machine.
function livePanes() {
  const machineOfTab = new Map(spaces().flatMap((space) => space.tabs.map((tab) => [tab.id, space.machine])));
  return panes().map((pane) => ({ ...pane, machine: machineOfTab.get(pane.tab) ?? null }));
}

function card(c, t) {
  const { title, place, rows } = describeCard(c);
  const [folder, ...git] = place;
  return v_flex()
    .id(`card-${c.id}`)
    .gap(2)
    .p(10)
    .rounded(6)
    .bg(t.surface)
    .border(1)
    .border_color(t.border)
    .child(div().text_size(13).font_semibold().text_color(t.foreground).truncate().child(title))
    .child(div().text_size(11).text_color(t.muted).truncate().child(folder ?? "n/a"))
    .children(git.map((line) => div().text_size(11).text_color(t.dim).truncate().child(line)))
    .child(
      v_flex()
        .gap(1)
        .pt(6)
        .children(
          rows.map(([label, value]) =>
            h_flex()
              .justify_between()
              .gap(8)
              .text_size(12)
              .child(div().flex_none().text_color(t.dim).child(label))
              .child(div().truncate().text_color(value === "n/a" ? t.dim : t.foreground).child(value)),
          ),
        ),
    );
}

// The drawer's card: one compact row. Its key figures (context used, cost) come first, so they
// are on the edge side and show while the drawer peeks; `mirror` puts that side on the right.
function compactCard(c, t, mirror) {
  const { title, place, rows } = describeCard(c);
  const value = (label) => rows.find(([name]) => name === label)?.[1] ?? "n/a";
  const { contextPercent } = c.stats;
  const context = typeof contextPercent === "number" ? `${Math.round(contextPercent * 100)}%` : "n/a";
  const figure = (text, size, color) => div().text_size(size).text_color(text === "n/a" ? t.dim : color).child(text);
  return h_flex()
    .id(`card-${c.id}`)
    .items_center()
    .gap(8)
    .px(6)
    .py(6)
    .border_b(1)
    .border_color(t.border)
    .when(mirror, (el) => el.flex_row_reverse())
    .child(
      v_flex()
        .flex_none()
        .w(52)
        .items_center()
        .child(figure(context, 13, t.foreground).font_semibold())
        .child(figure(value("Cost"), 11, t.muted)),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).truncate().child(title))
        .child(div().text_size(11).text_color(t.muted).truncate().child(place[0] ?? "n/a")),
    );
}

export default class SessionStats extends View {
  init(_props, cx) {
    this.cards = [];
    this.agents = null; // agent panes at the last tick, null before the first
    this.problem = null;
    this.lastError = null;
    this.builder = createCardBuilder({ exec, readTextFile, home: home() });
    cx.timer.every(REFRESH_INTERVAL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
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
    // No card yet is "No agents" only when herdr reports no agent pane; with agent panes it is
    // loading, however long a slow machine takes.
    const empty = this.agents === 0 ? "No agents" : "Loading…";
    const note = this.problem ?? (this.cards.length === 0 ? empty : null);
    // The container decides how the cards are listed: a column or a side edge stacks them, a
    // top or bottom edge puts them side by side, and a drawer on a side edge draws each card as
    // a compact row, mirrored on the right edge (src/adapt.js).
    const { direction, compact, mirror } = adapt({ placement: placement() });
    const vertical = direction === "vertical";
    const list = vertical
      ? v_flex().overflow_y_scrollbar()
      : h_flex().items_start().overflow_x_scrollbar();
    return list
      .id("session-stats")
      .size_full()
      .gap(compact ? 0 : 8)
      .p(compact ? 0 : 8)
      .bg(t.chrome)
      .children(
        this.cards.map((c) => {
          if (compact) return compactCard(c, t, mirror);
          return vertical ? card(c, t) : div().flex_none().w(260).child(card(c, t));
        }),
      )
      .when(note !== null, (el) => el.child(div().text_size(12).text_color(t.dim).child(note)));
  }
}
