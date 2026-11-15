import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { adapt } from '../src/adapt.js';
import { NA } from '../src/providers/index.js';
import { cardModel } from '../src/card-model.js';
import { formatCost, formatPercent } from '../src/format.js';

const modJson = JSON.parse(readFileSync(new URL('../mods/herdr-session-stats/mod.json', import.meta.url), 'utf8'));

// herdr's default size of an overlay a mod opens (AGENTS.md: "default 220×260 px")
const DEFAULT = { width: 220, height: 260 };

describe('three presentations of the one mod', () => {
  test('overlay size above default', () => {
    expect(modJson.overlay.width).toBeGreaterThan(DEFAULT.width);
    expect(modJson.overlay.height).toBeGreaterThan(DEFAULT.height);
    // the mod still asks for no place: herdr docks nothing into the layout in view
    expect(modJson.place).toBe('none');
  });

  test('overlay uses the extra room', () => {
    // herdr gives the overlay's mod `props().overlay` (its id) and no placement
    expect(adapt({ placement: null, overlay: 'overlay-1' })).toEqual({ direction: 'vertical', roomy: true });
    // the overlay draws roomy whatever the placement says
    expect(adapt({ placement: { edge: 'right', align: 'center', vertical: true, hovered: false, dragging: false }, overlay: 'o' })).toEqual({ direction: 'vertical', roomy: true });
    // outside an overlay nothing is roomy
    expect(adapt({ placement: null }).roomy).toBeUndefined();
  });
});

describe('the figures of the card', () => {
  test('percent and cost helpers read like the card', () => {
    expect(formatPercent(0.254)).toBe('25%');
    expect(formatPercent(NA)).toBe(NA);
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(NA)).toBe(NA);
    // the card model is built from the same helpers; every other figure reads n/a
    const known = { contextPercent: 0.25, contextMax: 200000, costUsd: 0.5 };
    const stats = new Proxy(known, { get: (target, key) => (key in target ? target[key] : NA) });
    const [, context, spend] = cardModel({ folder: '/x', harnessName: 'omp', stats }, { home: '/h' }).groups;
    expect(context.hero.value).toBe(formatPercent(0.25));
    expect(spend.hero.value).toBe(formatCost(0.5));
  });
});
