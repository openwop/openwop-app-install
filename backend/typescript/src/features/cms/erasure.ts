/**
 * UX_UPGRADE-content ROUND 3 — the CMS zero-eraser known-open, closed.
 *
 * The LOGIC lives in `cmsService.ts` beside the kernel page adapter (the legacy
 * `cms:page` collection is read-dark; an eraser with its own store handles
 * would write rows nothing reads — the first draft of this module did exactly
 * that and its own test caught it). This module only REGISTERS it, mirroring
 * the documents/media registration shape.
 */
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseCmsSubject } from './cmsService.js';

export { eraseCmsSubject, ERASED_SUBJECT } from './cmsService.js';

export function registerCmsErasure(): void {
  registerSubjectEraser(eraseCmsSubject);
  // No `declarePiiFields`: every identifier here is an opaque principal id (the
  // comments decision), and page CONTENT is the org's published site. The
  // retention question for page versions stays a product decision.
  //
  // The ADR 0748 `fields` section is page CONTENT under the same ruling
  // (`/grade-data` CMSPROBE-2, 2026-09-26). Its keys are author-chosen, so a key
  // named `email` holds an address the org chose to publish, exactly like one
  // typed into a `text` section. Declaring those key names would do harm: the
  // declaration registers the NAME globally for log masking, so an
  // author-chosen key would start masking unrelated fields host-wide. It would
  // also misclassify published content as subject data.
}
