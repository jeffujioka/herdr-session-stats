// herdr-session-stats: one card per agent pane with its folder, git state and session stats.
// The data work is in cards.js (copied here from src/ by scripts/sync.sh); this file wires
// herdr's live data, `exec` and timers to it and draws the result.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, panes, spaces, theme } from "herdr";
import { createCardBuilder, describeCard } from "./cards.js";
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

export default class SessionStats extends View {
  init(_props, cx) {
    this.cards = [];
    this.loaded = false;
    this.busy = false;
    this.builder = createCardBuilder({ exec, home: home() });
    cx.timer.every(REFRESH_INTERVAL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  // One refresh at a time: a slow machine makes the next tick skip, never pile up.
  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.cards = await this.builder.build(livePanes(), Date.now());
        this.loaded = true;
      } catch (error) {
        console.log(`herdr-session-stats: refresh failed: ${error?.message ?? error}`);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex()
      .id("session-stats")
      .size_full()
      .gap(8)
      .p(8)
      .bg(t.chrome)
      .overflow_y_scrollbar()
      .children(this.cards.map((c) => card(c, t)))
      .when(this.loaded && this.cards.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child("No agents")));
  }
}
