import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ToastViewport } from '@/components/game/Toast';
import type { Toast } from '@/lib/game/toast';

const SUCCESS: Toast = {
  id: 7,
  kind: 'success',
  title: 'Protection submitted',
  description: 'Target: TestBot 4 · You can change your target before the deadline.',
  autoDismissMs: 3000,
};

function render(toast: Toast = SUCCESS): string {
  return renderToStaticMarkup(createElement(ToastViewport, { toast, onDismiss: vi.fn() }));
}

describe('ToastViewport rendering', () => {
  it('renders the title and description', () => {
    const html = render();

    expect(html).toContain('Protection submitted');
    expect(html).toContain('Target: TestBot 4');
  });

  it('renders without a description', () => {
    const html = render({ ...SUCCESS, description: undefined });
    expect(html).toContain('Protection submitted');
  });

  it('is positioned out of the document flow', () => {
    // The whole point of the toast: it must not add height to the page.
    const html = render();

    expect(html).toContain('fixed');
    expect(html).toContain('inset-x-0 top-0');
    expect(html).not.toContain('relative');
  });

  it('keeps the positioning layer inert but the body interactive', () => {
    const html = render();

    // Exactly two: the wrapper (inert) and the body (interactive).
    expect(html.match(/pointer-events-none/g) ?? []).toHaveLength(1);
    expect(html).toContain('pointer-events-auto');
  });

  it('offers a labelled dismiss control', () => {
    const html = render();

    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Dismiss success notification"');
  });

  it('respects mobile safe areas and stays narrow', () => {
    const html = render();

    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('max-w-sm');
    // Centered at top on all screen sizes.
    expect(html).toContain('justify-center');
  });

  it('marks the kind so styling and tests can target it', () => {
    expect(render()).toContain('data-toast-kind="success"');
    expect(render({ ...SUCCESS, kind: 'error' })).toContain('data-toast-kind="error"');
  });

  it('gives errors a distinct, non-success treatment', () => {
    const error = render({ ...SUCCESS, kind: 'error', autoDismissMs: null });
    expect(error).toContain('aria-label="Dismiss error notification"');
    expect(error).toContain('border-rose-400/45');
    expect(error).not.toContain('border-emerald-400/45');
  });

  it('exposes a polite live region wrapper for announcements', () => {
    const html = render();
    expect(html).toContain('aria-label="Notifications"');
  });

  it('uses a near-opaque surface so it stays readable over the backdrop', () => {
    const html = render();
    // No backdrop-filter: it is what allowed a full-screen layer to capture
    // hit-testing previously.
    expect(html).toContain('bg-[#0f1a12]/97');
  });
});