/* Brain Canvas — palette selection (canvas/palettes.ts) and the
   palette-aware cluster color resolver (brainAdapter.ts's
   resolveClusterColors), which together drive the 4 selectable palettes
   feature (Spectre/Hologramme/Néon violet/Aurore).
*/

import { describe, it, expect } from 'vitest';
import { DEFAULT_PALETTE, PALETTE_IDS, PALETTES, hexA, isPaletteId } from '../components/brain/canvas/palettes';
import { resolveClusterColors } from '../lib/brain/brainAdapter';

describe('canvas/palettes — PALETTES data', () => {
  it('exposes exactly the 4 palettes from the design handoff', () => {
    expect(PALETTE_IDS).toEqual(['spectre', 'hologramme', 'neon', 'aurore']);
  });

  it('gives every palette exactly 5 swatches (one per real IDE cluster)', () => {
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].colors).toHaveLength(5);
    }
  });

  it('matches the exact swatch arrays extracted from the handoff prototype', () => {
    expect(PALETTES.spectre.colors).toEqual(['#9B7CFF', '#4FC3F7', '#66E27A', '#FFC76B', '#FF7BB0']);
    expect(PALETTES.hologramme.colors).toEqual(['#6FD0FF', '#3FA0F5', '#56E0CE', '#9AD8FF', '#C2ECFF']);
    expect(PALETTES.neon.colors).toEqual(['#9B7CFF', '#7C5CFF', '#B47CFF', '#FF7BD5', '#D682FF']);
    expect(PALETTES.aurore.colors).toEqual(['#7C5CFF', '#33D6C0', '#66E27A', '#5BD6FF', '#B07CFF']);
  });

  it('defaults to spectre', () => {
    expect(DEFAULT_PALETTE).toBe('spectre');
  });

  it('isPaletteId narrows known ids and rejects unknown strings', () => {
    expect(isPaletteId('spectre')).toBe(true);
    expect(isPaletteId('aurore')).toBe(true);
    expect(isPaletteId('rainbow')).toBe(false);
  });
});

describe('canvas/palettes — hexA', () => {
  it('converts a hex color + alpha into an rgba() string', () => {
    expect(hexA('#9B7CFF', 0.5)).toBe('rgba(155,124,255,0.5)');
  });

  it('handles pure black/white correctly', () => {
    expect(hexA('#000000', 1)).toBe('rgba(0,0,0,1)');
    expect(hexA('#FFFFFF', 0)).toBe('rgba(255,255,255,0)');
  });
});

describe('brainAdapter — resolveClusterColors', () => {
  const REAL_CLUSTERS = ['editor', 'agents', 'brain', 'tauri', 'models', 'topical', 'unknown'];

  it('is identical to the legacy REAL_CLUSTER_COLOR constants for the default (spectre) palette', () => {
    const colors = resolveClusterColors('spectre', REAL_CLUSTERS);
    expect(colors).toEqual({
      editor: '#9B7CFF',
      agents: '#4FC3F7',
      brain: '#66E27A',
      tauri: '#FFC76B',
      models: '#FF7BB0',
      topical: '#F472B6',
      unknown: '#888888',
    });
  });

  it('changes real-cluster colors when a different palette is selected', () => {
    const spectre = resolveClusterColors('spectre', REAL_CLUSTERS);
    const hologramme = resolveClusterColors('hologramme', REAL_CLUSTERS);
    expect(hologramme.editor).not.toBe(spectre.editor);
    expect(hologramme.editor).toBe('#6FD0FF');
    expect(hologramme.agents).toBe('#3FA0F5');
  });

  it('keeps topical and unknown constant across every palette', () => {
    for (const id of PALETTE_IDS) {
      const colors = resolveClusterColors(id, REAL_CLUSTERS);
      expect(colors.topical).toBe('#F472B6');
      expect(colors.unknown).toBe('#888888');
    }
  });

  it('maps legacy mock clusters onto the same slots as their real-cluster counterparts', () => {
    const real = resolveClusterColors('neon', ['editor', 'agents', 'brain', 'tauri', 'models']);
    const mock = resolveClusterColors('neon', ['Auth', 'Paiement', 'Tests', 'Infra', 'UI']);
    expect(mock.Auth).toBe(real.editor);
    expect(mock.Paiement).toBe(real.agents);
    expect(mock.Tests).toBe(real.brain);
    expect(mock.Infra).toBe(real.tauri);
    expect(mock.UI).toBe(real.models);
  });

  it('assigns a stable fallback color to unrecognized cluster names by cycling the palette', () => {
    const colors = resolveClusterColors('spectre', ['mystery-cluster-a', 'mystery-cluster-b']);
    expect(colors['mystery-cluster-a']).toBe(PALETTES.spectre.colors[0]);
    expect(colors['mystery-cluster-b']).toBe(PALETTES.spectre.colors[1]);
  });
});
