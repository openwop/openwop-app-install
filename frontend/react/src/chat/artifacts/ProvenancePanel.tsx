/**
 * ProvenancePanel (ADR 0069) — the operator's "where did this come from" view:
 * source run/node, producing subject, template, artifact type. Read-only; every
 * value is projected from the durable record (no secret/credential material).
 */

import { useTranslation } from 'react-i18next';
import type { ArtifactProjection } from './artifactClient.js';

interface Row { label: string; value: string | undefined }

export function ProvenancePanel({ artifact }: { artifact: ArtifactProjection }): JSX.Element {
  const { t } = useTranslation('chat');
  const p = artifact.provenance;
  const rows: Row[] = [
    { label: t('artifactProvType'), value: artifact.artifactTypeId },
    { label: t('artifactProvSource'), value: `${artifact.source}:${artifact.sourceId}` },
    { label: t('artifactProvProducedBy'), value: p.producedBy ? `${p.producedBy.kind}:${p.producedBy.id}` : undefined },
    { label: t('artifactProvRun'), value: p.runId },
    { label: t('artifactProvNode'), value: p.nodeId },
    { label: t('artifactProvTemplate'), value: p.templateId },
    { label: t('artifactProvOwner'), value: artifact.ownerSubject ? `${artifact.ownerSubject.kind}:${artifact.ownerSubject.id}` : undefined },
    { label: t('artifactProvOrg'), value: artifact.orgId },
  ];
  return (
    <dl className="artifact-provenance">
      {rows.filter((r) => r.value).map((r) => (
        <div key={r.label} className="artifact-provenance__row">
          <dt>{r.label}</dt>
          <dd><code>{r.value}</code></dd>
        </div>
      ))}
    </dl>
  );
}
