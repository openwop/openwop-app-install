/**
 * `notebooks` namespace — user-facing copy for the Research Notebooks feature
 * (ADR 0084). Feature-self-contained: every notebooks string lives here. Generic
 * actions (delete) are reused from the `common` namespace via `t('common:…')`.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Research',
  title: 'Notebooks',
  lede: 'Grounded research notebooks — collect sources, take notes, and ask questions grounded in them.',
  workspaceLede: 'Sources, notes, and a grounded ask over this notebook.',

  // Gating
  notEnabledTitle: 'Notebooks is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the Research Notebooks feature in Admin → Feature toggles.',

  // Chooser
  nameLabel: 'Notebook name',
  namePlaceholder: 'Market research',
  orgLabel: 'Organization',
  createNotebook: 'Create notebook',
  created: 'Notebook created.',
  createFailed: 'Failed to create the notebook.',
  loadFailed: 'Failed to load.',
  deleteFailed: 'Delete failed.',
  open: 'Open',
  deleteNotebookLabel: 'Delete {{name}}',
  deleteNotebookConfirm: 'Delete “{{name}}”? This can\'t be undone.',
  emptyTitle: 'No notebooks yet',
  emptyBody: 'Create your first research notebook with the form above — then add sources and ask questions grounded in them.',
  backToList: 'Back to notebooks',

  // Sources panel
  sourcesTitle: 'Sources',
  sourceTitleLabel: 'Source title (optional)',
  sourceTitlePlaceholder: 'Q3 analyst report',
  sourceTextLabel: 'Source text',
  sourceTextPlaceholder: 'Paste the text you want to ground answers in…',
  addSource: 'Add source',
  sourceAdded: 'Source added.',
  sourceAddFailed: 'Failed to add the source.',
  // Audio / video / YouTube sources (ADR 0085)
  addAudioLabel: 'Audio or video file',
  addFileLabel: 'Document file (PDF, DOCX, text)',
  fileTooLarge: 'That file is too large (max {{max}} MB).',
  uploading: 'Uploading…',
  addFileHint: 'Upload a document — its text is extracted and added as a source.',
  addAudioHint: 'Upload a recording — it’s transcribed and added as a source.',
  addAudioBtn: 'Transcribe & add',
  audioEnqueued: 'Transcribing your recording — the source will appear shortly.',
  audioFailed: 'Failed to start transcription.',
  addYoutubeLabel: 'YouTube URL',
  addYoutubePlaceholder: 'https://www.youtube.com/watch?v=…',
  addYoutubeBtn: 'Add from YouTube',
  youtubeEnqueued: 'Fetching the transcript — the source will appear shortly.',
  youtubeFailed: 'Failed to add the YouTube source.',
  noSourcesTitle: 'No sources yet',
  noSourcesBody: 'Add a text source above — its chunks become searchable evidence for the ask.',
  chunkCount_one: '{{count}} chunk',
  chunkCount_other: '{{count}} chunks',
  approxTokens: '~{{tokens}} tokens',
  contextBudget: '~{{tokens}} tokens in context',
  contextBudgetHint: 'Approximate token total for the sources currently in context (excludes excluded sources).',
  contextLevelLabel: 'Context level for {{title}}',
  contextLevelFailed: 'Failed to change the context level.',
  levelFull: 'Full',
  levelSummary: 'Summary',
  levelSummaryHint: 'Summarize the source first to use the Summary level.',
  levelSummaryReadyHint: 'Inject the short summary instead of the full source.',
  levelExcluded: 'Excluded',
  summarize: 'Summarize',
  resummarize: 'Re-summarize',
  summarizing: 'Summarizing…',
  summarizeHint: 'Generate a short LLM summary so this source can use the Summary level.',
  resummarizeHint: 'Regenerate the summary for this source.',
  summarizeStarted: 'Summarizing the source… refresh in a moment to use the Summary level.',
  summarizeFailed: 'Failed to start the summary.',

  // Transformations (ADR 0084 T2) — apply a template (Summary / Key Concepts / …);
  // the result is written as a Document owned by this notebook.
  transform: 'Transform',
  transforming: 'Transforming…',
  transformLabel: 'Apply a transformation to {{title}}',
  transformHint: 'Apply a transformation template — the result is written as a Document.',
  transformStarted: 'Applying the transformation… the result will appear under Transformations.',
  transformFailed: 'Failed to start the transformation.',
  transformationsTitle: 'Transformations',
  transformationsNote: 'Applied-transformation results are saved as Documents owned by this notebook.',
  noTransformationsTitle: 'No transformations yet',
  noTransformationsBody: 'Use the Transform menu on a source to generate a Summary, Key Concepts, and more.',
  openInDocuments: 'Open in Documents',

  // Notes panel
  notesTitle: 'Notes',
  noteLabel: 'New note',
  notePlaceholder: 'Jot a finding or takeaway…',
  addNote: 'Add note',
  noteAdded: 'Note saved.',
  noteAddFailed: 'Failed to save the note.',
  noNotesTitle: 'No notes yet',
  noNotesBody: 'Capture findings here — or save a search answer straight to your notes.',
  saveToNotes: 'Save to notes',

  // Ask panel
  askTitle: 'Ask',
  askLabel: 'Ask a question',
  askPlaceholder: 'What do the sources say about…?',
  ask: 'Ask',
  askFailed: 'Search failed.',
  noHitsTitle: 'No matches',
  noHitsBody: 'No source passages matched that question — add more sources or rephrase.',
  score: '{{score}}%',

  // Chat panel
  chatTitle: 'Chat',
  chatGroundedNote: 'This chat is grounded in this notebook’s sources — the KB Researcher answers from what you’ve added here.',
  chatLaunchTitle: 'Chat with the Researcher',
  chatLaunchBody: 'Open a grounded conversation with the KB Researcher, scoped to this notebook’s sources.',
  openChat: 'Open chat',
  chatOpening: 'Opening…',
  chatOpenFailed: 'Could not open the notebook chat.',
} as const;
