/**
 * Deferred Phase E.2 (ADR 0197 OQ-2) — the Inspector's "Run inputs" section:
 * the schema textarea is store-backed, a renderable draft shows the live
 * SchemaInputForm preview, and an unparseable draft shows the honest
 * kept-but-not-published note instead of a preview.
 *
 * "Store-backed" is asserted in BOTH directions: the textarea shows the store value, and
 * typing writes back to the store and re-derives the preview. Red under: an unbound
 * textarea value, a dropped onChange write, no preview for a renderable schema, no note
 * (or a preview) for an unparseable draft (probes w32g3-insp-*).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { WorkflowInspector } from '../WorkflowInspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

afterEach(() => { cleanup(); useBuilderStore.getState().setInputSchema(''); });

describe('WorkflowInspector run-input schema (Phase E.2)', () => {
  it('renders the store-backed schema textarea + live preview for a renderable schema', () => {
    useBuilderStore.getState().setInputSchema(
      '{"type":"object","properties":{"city":{"type":"string","title":"City"}},"required":["city"]}',
    );
    render(<WorkflowInspector />);

    const area = screen.getByLabelText('Input schema (JSON Schema)') as HTMLTextAreaElement;
    expect(area.value).toContain('"city"');
    // The live preview renders the derived field (SchemaInputForm, runs ns).
    expect(screen.getByText('Launch form preview')).toBeTruthy();
    expect(screen.getByLabelText(/City/)).toBeTruthy();

    // The write direction: typing a new schema lands in the store and the preview follows.
    fireEvent.change(area, {
      target: { value: '{"type":"object","properties":{"zip":{"type":"string","title":"Zip code"}}}' },
    });
    expect(useBuilderStore.getState().inputSchema).toContain('"zip"');
    expect(screen.getByLabelText(/Zip code/)).toBeTruthy();
    expect(screen.queryByLabelText(/City/)).toBeNull();
  });

  it('an unparseable draft shows the kept-but-not-published note, no preview', () => {
    useBuilderStore.getState().setInputSchema('{"type":');
    render(<WorkflowInspector />);
    expect(screen.getByText(/Not valid JSON yet/)).toBeTruthy();
    expect(screen.queryByText('Launch form preview')).toBeNull();
  });
});
