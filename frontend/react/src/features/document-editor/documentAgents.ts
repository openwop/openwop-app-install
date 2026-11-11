/**
 * The document editor's chat-drive target (ADR 0058; ADR 1055 D4): the Writing
 * Assistant (`vendor.openwop-app.document-editor.agents`). Its pack activates the
 * core `text-only` capability for it, so it is offered no tools at all, and a
 * reply reaches the document only when the user applies it as a tracked
 * suggestion. Both entry points use this one id, the toolbar "Ask AI" and the
 * selection "Improve with AI", so they cannot drift. (Before ADR 1055 this was
 * the markdown Documents store's author, whose tools save documents there.)
 */
export const DOCUMENT_WRITING_AGENT = 'vendor.openwop-app.document-editor.agents.writing-assistant';
