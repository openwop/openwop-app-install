/**
 * Personal Knowledge tab (ADR 0042) — the human counterpart of the agent
 * Knowledge panel. A person binds cited documents to their OWN profile (the
 * digital-twin corpus, alongside the Memory tab's notes). A THIN wrapper over the
 * shared `<SubjectKnowledgePanel>` (ADR 0046 follow-on): same UI as the project
 * Knowledge tab, parameterized by a profile-scoped client + copy.
 */

import { Trans, useTranslation } from 'react-i18next';
import { SubjectKnowledgePanel, type SubjectKnowledgeClient } from '../../knowledge/SubjectKnowledgePanel.js';
import {
  getProfileKnowledge, listOrgs, createCollection, unbindCollection, ingestText, deleteDocument, retrieve,
} from './profileKnowledgeClient.js';

const client: SubjectKnowledgeClient = {
  getKnowledge: () => getProfileKnowledge(),
  listOrgs: () => listOrgs(),
  createCollection: (orgId, name) => createCollection(orgId, name),
  unbindCollection: (collectionId) => unbindCollection(collectionId),
  ingestText: (orgId, collectionId, title, text) => ingestText(orgId, collectionId, title, text),
  deleteDocument: (orgId, collectionId, documentId) => deleteDocument(orgId, collectionId, documentId),
  retrieve: (query) => retrieve(query),
};

export function ProfileKnowledgeTab(): JSX.Element {
  const { t } = useTranslation('profile-memory');
  return (
    <SubjectKnowledgePanel
      client={client}
      copy={{
        intro: <Trans i18nKey="knowledgeIntro" ns="profile-memory" components={{ 0: <strong /> }} />,
        emptyBody: t('knowledgeEmptyBody'),
        searchTitle: t('knowledgeSearchTitle'),
        searchPlaceholder: t('knowledgeSearchPlaceholder'),
      }}
    />
  );
}
