/**
 * Layout primitives — Panel, Toolbar, MetadataRow, FormRow.
 *
 * These replace the recurring bespoke `<div style={{ border…, padding… }}>`
 * clusters the enterprise review flagged. Each is a thin, token-anchored
 * wrapper (styles live in global.css) so layout stays consistent and
 * auditable instead of drifting per page.
 */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

/** Bordered surface container with an optional title. */
export function Panel({
  title, children, className, ...rest
}: { title?: React.ReactNode } & DivProps): JSX.Element {
  return (
    <div className={className ? `panel ${className}` : 'panel'} {...rest}>
      {title ? <h3 className="panel-title">{title}</h3> : null}
      {children}
    </div>
  );
}

/** Horizontal action/control row that wraps on narrow viewports. Use
 *  <Toolbar.Spacer/> to push trailing items to the right. */
export function Toolbar({ children, className, ...rest }: DivProps): JSX.Element {
  return (
    <div className={className ? `toolbar ${className}` : 'toolbar'} role="toolbar" {...rest}>
      {children}
    </div>
  );
}
Toolbar.Spacer = function ToolbarSpacer(): JSX.Element {
  return <span className="toolbar-spacer" aria-hidden="true" />;
};

/** A single label/value metadata pair rendered as a <dl> row. */
export function MetadataRow({
  label, children,
}: { label: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <dl className="metadata-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </dl>
  );
}

/** Spacing wrapper for a label+control pair (matches the legacy `.form-row`). */
export function FormRow({ children, className, ...rest }: DivProps): JSX.Element {
  return (
    <div className={className ? `form-row ${className}` : 'form-row'} {...rest}>
      {children}
    </div>
  );
}
