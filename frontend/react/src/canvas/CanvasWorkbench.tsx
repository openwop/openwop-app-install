/**
 * CanvasWorkbench (ADR 0739) — the visual frame shared by every full-screen
 * canvas composition. A document-backed editor and an engine-backed surface
 * still own their different lifecycle, persistence, and undo models.
 *
 * The boundary is deliberately small: a workbench is not a second editor
 * framework. It is the stable command, mode, rail, stage, and status grammar
 * that every canvas can share.
 */
import type { ReactNode } from 'react';

export interface CanvasWorkbenchProps {
  /** The existing composition class (`cv-editor`, `builder-shell`, …). */
  className: string;
  children: ReactNode;
}

export function CanvasWorkbench({ className, children }: CanvasWorkbenchProps): JSX.Element {
  return <div className={`${className} cv-workbench`} data-canvas-layout="workbench">{children}</div>;
}

export interface CanvasWorkbenchStatusProps {
  label: string;
  children: ReactNode;
  className?: string;
}

/** A single semantic bottom context bar. Consumers supply only truthful state. */
export function CanvasWorkbenchStatus({ label, children, className }: CanvasWorkbenchStatusProps): JSX.Element {
  return <footer className={`cv-workbench__status${className ? ` ${className}` : ''}`} aria-label={label}>{children}</footer>;
}
