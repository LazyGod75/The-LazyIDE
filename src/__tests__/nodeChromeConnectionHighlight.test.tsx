/**
 * nodeChromeConnectionHighlight.test.tsx — W-BYO nit (b), Langflow "typed
 * drop zones" parity. Proves NodeCard's compatible-connection-drag glow is
 * actually rendered (the pre-existing CSS class's box-shadow was silently
 * overridden by this component's own unconditional inline `boxShadow` —
 * see nodeChrome.tsx's updated comment) AND that it is colored by the
 * card's own `typeAccent`, giving each target KIND a distinct glow color.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NodeCard } from '../components/agents/canvas/chrome/nodeChrome';

describe('NodeCard — connection-drag highlight', () => {
  it('renders the canvas-connect-compatible class and an accent-colored box-shadow when compatible', () => {
    const { getByTestId } = render(
      <NodeCard testId="card-a" typeAccent="#66E27A" connectionHighlight="compatible">
        content
      </NodeCard>,
    );
    const el = getByTestId('card-a');
    expect(el.className).toContain('canvas-connect-compatible');
    const style = el.getAttribute('style') ?? '';
    expect(style).toContain('#66E27A');
  });

  it('a different typeAccent produces a differently-colored glow (per-target-kind cue)', () => {
    const { getByTestId } = render(
      <NodeCard testId="card-b" typeAccent="#FFC76B" connectionHighlight="compatible">
        content
      </NodeCard>,
    );
    const style = getByTestId('card-b').getAttribute('style') ?? '';
    expect(style).toContain('#FFC76B');
    expect(style).not.toContain('#66E27A');
  });

  it('renders the canvas-connect-incompatible class when incompatible, no accent glow', () => {
    const { getByTestId } = render(
      <NodeCard testId="card-c" typeAccent="#66E27A" connectionHighlight="incompatible">
        content
      </NodeCard>,
    );
    const el = getByTestId('card-c');
    expect(el.className).toContain('canvas-connect-incompatible');
    expect(el.className).not.toContain('canvas-connect-compatible');
  });

  it('a selected card keeps its selection ring even during a compatible drag (selected wins)', () => {
    const { getByTestId } = render(
      <NodeCard testId="card-d" typeAccent="#66E27A" connectionHighlight="compatible" selected>
        content
      </NodeCard>,
    );
    const style = getByTestId('card-d').getAttribute('style') ?? '';
    expect(style).toContain('18%');
  });

  it('no connectionHighlight renders neither class and no highlight glow', () => {
    const { getByTestId } = render(
      <NodeCard testId="card-e" typeAccent="#66E27A">
        content
      </NodeCard>,
    );
    const el = getByTestId('card-e');
    expect(el.className).not.toContain('canvas-connect-compatible');
    expect(el.className).not.toContain('canvas-connect-incompatible');
  });
});
