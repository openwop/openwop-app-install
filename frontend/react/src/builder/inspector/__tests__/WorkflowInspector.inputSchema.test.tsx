/**
 * Deferred Phase E.2 (ADR 0197 OQ-2) — the Inspector's "Run inputs" section:
 * the schema textarea is store-backed, a renderable draft shows the live
 * SchemaInputForm preview, and an unparseable draft shows the honest
 * kept-but-not-published note instead of a preview.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WorkflowInspector } from '../WorkflowInspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

afterEach(cleanup);

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
  });

  it('an unparseable draft shows the kept-but-not-published note, no preview', () => {
    useBuilderStore.getState().setInputSchema('{"type":');
    render(<WorkflowInspector />);
    expect(screen.getByText(/Not valid JSON yet/)).toBeTruthy();
    expect(screen.queryByText('Launch form preview')).toBeNull();
  });
});
