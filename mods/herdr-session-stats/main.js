// herdr-session-stats: one card per agent pane with its folder, git state and session stats.
// The data work is in cards.js (copied here from src/ by scripts/sync.sh); this file wires
// herdr's live data, `exec` and timers to it and draws the result.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, panes, placement, props, readTextFile, settings, spaces, theme } from "herdr";
import { adapt } from "./adapt.js";
import { cardModel } from "./card-model.js";
import { agentPanes, createCardBuilder, panesOfActiveSpace } from "./cards.js";
import { REFRESH_INTERVAL_MS } from "./refresh.js";

// The panes of the shown space as `panes()` reports them, each with the machine of its space:
// the pane's tab names the space it is in, and the space the machine.
function livePanes() {
  const all = spaces();
  const machineOfTab = new Map(all.flatMap((space) => space.tabs.map((tab) => [tab.id, space.machine])));
  return panesOfActiveSpace(panes(), all).map((pane) => ({ ...pane, machine: machineOfTab.get(pane.tab) ?? null }));
}

// Sizes in px, in one place to tune the look: the card's title, a group's heading, labels, the
// figures' text, the hero figures (context percent and cost) and the time left of the cache.
const TYPE = { title: 14, section: 10.5, label: 11, body: 12, hero: 20, heroSmall: 14 };
const SPACE = { pad: 12, gap: 10, meter: 6, column: 16 };
const HERO_SIZE = { context: TYPE.hero, spend: TYPE.hero, cache: TYPE.heroSmall };

// Used when settings() names no font for the terminals.
const MONO_FALLBACK = "JetBrains Mono";

// The color of each tone of the view model (src/card-model.js), all from the theme so the card
// follows a light and a dark theme alike: the gauge's tones are the accent and the theme's
// yellow and red, an unknown figure is dim, the agent's status the theme's status colors.
function toneColors(t) {
  return {
    normal: t.foreground,
    ok: t.accent,
    warning: t.ansi3,
    danger: t.ansi1,
    dim: t.dim,
    working: t.working,
    blocked: t.blocked,
    done: t.done,
    idle: t.idle,
  };
}

const text = (size, color) => div().text_size(size).text_color(color);

const pct = (share) => `${(share * 100).toFixed(1)}%`;

// A bar: `fraction` of the track filled (nothing when unknown), and a thin tick at
// `tickFraction` when there is one.
function meter(fraction, tickFraction, color, t) {
  return div()
    .relative()
    .w_full()
    .h(SPACE.meter)
    .rounded(SPACE.meter / 2)
    .overflow_hidden()
    .bg(t.raised)
    .when(fraction !== null, (el) => el.child(div().h_full().w(pct(fraction)).bg(color)))
    .when(tickFraction !== null, (el) => el.child(div().absolute().top(0).left(pct(tickFraction)).w(2).h_full().bg(t.muted)));
}

// The identity group: the status dot and the folder's name with the status word, the path, the
// branch and remote (and the machine of a remote pane), the harness and the model.
function identity(g, { t, tones, mono }) {
  const place = [g.branch === null ? null : `⎇ ${g.branch}`, g.remote].filter(Boolean).join(" · ");
  return v_flex()
    .gap(3)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(div().flex_none().w(8).h(8).rounded(4).bg(tones[g.status.tone]))
        .child(text(TYPE.title, tones[g.name.tone]).flex_1().min_w_0().truncate().font_semibold().child(g.name.value))
        .child(text(TYPE.label, t.muted).flex_none().child(g.status.label)),
    )
    .child(text(TYPE.label, t.dim).truncate().font_family(mono).child(g.path.value))
    .when(place !== "" || g.machine !== null, (el) =>
      el.child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .child(text(TYPE.label, t.muted).flex_1().min_w_0().truncate().child(place))
          .when(g.machine !== null, (chip) =>
            chip.child(text(TYPE.label, t.muted).flex_none().px(6).rounded(4).bg(t.raised).child(g.machine)),
          ),
      ),
    )
    .child(
      h_flex()
        .gap(6)
        .min_w_0()
        .overflow_hidden()
        .child(text(TYPE.label, tones[g.harness.tone]).flex_none().child(g.harness.value))
        .child(text(TYPE.label, t.dim).flex_none().child("·"))
        .child(text(TYPE.label, tones[g.model.tone]).min_w_0().truncate().child(g.model.value)),
    );
}

// A group under the first: its heading with the hero figure on the right, the gauge or the
// bar of the group when it has one, and its figures as label and value pairs that wrap.
function section(g, { t, tones, mono }) {
  return v_flex()
    .gap(6)
    .pt(SPACE.gap)
    .border_t(1)
    .border_color(t.border)
    .child(
      h_flex()
        .items_baseline()
        .justify_between()
        .gap(8)
        .child(text(TYPE.section, t.dim).font_semibold().child(g.title))
        .when(g.hero !== null, (el) =>
          el.child(
            h_flex()
              .items_baseline()
              .gap(4)
              .child(text(HERO_SIZE[g.id], tones[g.hero.tone]).font_semibold().font_family(mono).child(g.hero.value))
              .when(g.hero.label !== "", (hero) => hero.child(text(TYPE.label, t.muted).child(g.hero.label))),
          ),
        ),
    )
    .when(g.gauge !== undefined, (el) => el.child(meter(g.gauge.fraction, g.gauge.tickFraction, tones[g.gauge.tone], t)))
    .when(g.bar !== undefined && g.bar !== null, (el) => el.child(meter(g.bar.fraction, null, tones[g.bar.tone], t)))
    .child(
      h_flex()
        .flex_wrap()
        .gap_x(12)
        .children(
          g.figures.map((f) =>
            h_flex()
              .gap(4)
              .child(text(TYPE.label, t.muted).child(f.label))
              .child(text(TYPE.body, tones[f.tone]).font_family(mono).child(f.value)),
          ),
        ),
    );
}

// A card: the identity group, then the four detail groups, one under the other, or (`grid`,
// the overlay's) two by two. The focused pane's card has an accent border.
function card(model, look, grid) {
  const [first, ...rest] = model.groups;
  const detail = grid
    ? [rest.slice(0, 2), rest.slice(2)].map((pair) =>
        h_flex()
          .items_start()
          .gap(SPACE.column)
          .children(pair.map((g) => div().flex_1().min_w_0().child(section(g, look)))),
      )
    : rest.map((g) => section(g, look));
  return v_flex()
    .id(`card-${model.id}`)
    .gap(SPACE.gap)
    .p(SPACE.pad)
    .rounded(8)
    .bg(look.t.surface)
    .border(1)
    .border_color(model.focused ? look.t.accent : look.t.border)
    .child(identity(first, look))
    .children(detail);
}

export default class SessionStats extends View {
  init(_props, cx) {
    this.cards = [];
    this.agents = null; // agent panes at the last tick, null before the first
    this.problem = null;
    this.lastError = null;
    this.home = home();
    this.builder = createCardBuilder({ exec, readTextFile, home: this.home });
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
    const look = { t, tones: toneColors(t), mono: settings().font_family ?? MONO_FALLBACK };
    // No card yet is "No agents" only when herdr reports no agent pane; with agent panes it is
    // loading, however long a slow machine takes.
    const empty = this.agents === 0 ? "No agents" : "Loading…";
    const note = this.problem ?? (this.cards.length === 0 ? empty : null);
    // The container decides how the cards are listed: a column stacks them and draws each card's
    // groups one under the other, a top or bottom edge puts the cards side by side, and the
    // overlay (`roomy`) puts the four detail groups of a card in two columns (src/adapt.js).
    const { direction, roomy } = adapt({ placement: placement(), overlay: props()?.overlay });
    const vertical = direction === "vertical";
    const list = vertical
      ? v_flex().overflow_y_scrollbar()
      : h_flex().items_start().overflow_x_scrollbar();
    return list
      .id("session-stats")
      .size_full()
      .gap(SPACE.gap)
      .p(SPACE.gap)
      .bg(t.chrome)
      .children(
        this.cards.map((c) => {
          const view = card(cardModel(c, { home: this.home }), look, roomy);
          return vertical ? view : div().flex_none().w(260).child(view);
        }),
      )
      .when(note !== null, (el) => el.child(text(TYPE.body, t.muted).p(SPACE.pad).child(note)));
  }
}
