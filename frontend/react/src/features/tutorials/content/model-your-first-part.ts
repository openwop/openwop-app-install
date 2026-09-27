/**
 * Tutorial: Model Your First Part (round-4 CAD-R2-2, ADR 0488 lane) — the CAD
 * editor's read-and-follow lessons. Authored data, no chain bindings: no cad
 * walkthrough chain exists yet, and the binding-drift guard forbids a
 * dangling "Show me" (bind at step level via `run` when one lands — D2).
 */
import type { TutorialData } from '../tutorialTypes.js';

export const modelYourFirstPart: TutorialData = {
  id: 'model-your-first-part',
  category: 'build',
  title: 'Model Your First Part',
  description: 'Create a CAD model, size a solid precisely, learn the orbit view, and finish with materials, a dimension, and the AI modeler.',
  hero: { title: 'Model Your First Part', subtitle: 'From an empty canvas to a dimensioned, material-real solid' },
  goal: 'Learn the CAD editor end to end: solids and precise properties, 3D navigation with the view cube, the closed material catalog, dimensioning with tolerances, and the in-editor CAD Modeler.',
  learningObjectives: [
    'Create a CAD model and add solids',
    'Set exact dimensions in the property panel',
    'Navigate in 3D with the orbit view and the view cube',
    'Apply a library material and annotate a dimension',
    'Drive a change with the CAD Modeler and undo it',
  ],
  prerequisites: ['The CAD feature enabled', 'An AI provider connected (BYOK or managed) — the CAD Modeler creates the model you edit'],
  estimatedMinutes: 15,
  difficulty: 'beginner',
  surfaces: ['/cad'],
  phases: [
    {
      number: 1,
      title: 'Solids and the 3D view',
      goal: 'Create a model, size a solid exactly, and learn to look at it from every side.',
      outcome: 'A box with real dimensions you can inspect from any angle.',
      steps: [
        {
          id: '1.1',
          title: 'Create a model',
          content: [
            { type: 'instructions', items: [
              { text: 'Open the chat and ask the CAD Modeler for a starting shape — for example “model a 40×30×20mm bracket”.' },
              { text: 'It renders a real model and answers with a card; press “Open in editor” on that card to land in the CAD editor.' },
              { text: 'Name the model in the toolbar (something like “Bracket” beats “Untitled model” later).' },
            ] },
            { type: 'callout', variant: 'info', title: 'There is no CAD list — and that is deliberate', body: 'The CAD editor is deep-link only: you reach a model from the chat card that made it, or from a link someone shares. There is no CAD entry in the sidebar to hunt for. A CAD model is a canvas document — the solid list on the left, the property panel on the right, the live preview in the centre — and everything you change is undoable from the toolbar history.' },
          ],
        },
        {
          id: '1.2',
          title: 'Size the box precisely',
          content: [
            { type: 'instructions', items: [
              { text: 'Select the box in the solid list.' },
              { text: 'In the property panel, set Width, Height, and Depth to exact values — the preview updates as you type.' },
              { text: 'Set the model’s Units in the document properties (mm, cm, m, or in) so the numbers mean what you intend.' },
            ] },
          ],
        },
        {
          id: '1.3',
          title: 'Orbit, and the view cube',
          content: [
            { type: 'instructions', items: [
              { text: 'Switch to the 3D view and drag to orbit — or focus the view and use the arrow keys.' },
              { text: 'Use the view cube in the corner: click a face to snap Front, Top, or Right; the arrows step 90°; the home button returns to the ¾ view.' },
            ] },
            { type: 'callout', variant: 'info', title: 'The cube never lies', body: 'The view cube is drawn with the same rotation as the model, so it always shows the true orientation — if the cube says Top, you are looking at the top.' },
          ],
        },
      ],
    },
    {
      number: 2,
      title: 'Materials, dimensions, and the AI modeler',
      goal: 'Make the part real: a material, an annotated dimension, and an AI-driven change you can undo.',
      outcome: 'A material-real, dimensioned part — and you have seen the CAD Modeler edit it live.',
      steps: [
        {
          id: '2.1',
          title: 'Apply a material',
          content: [
            { type: 'instructions', items: [
              { text: 'With the box selected, open Material in the property panel and pick from the catalog — the swatch shows the colour before you commit.' },
              { text: 'Fine-tune Metallic and Roughness (0–1) and watch the shading change in the 3D view.' },
            ] },
          ],
        },
        {
          id: '2.2',
          title: 'Annotate a dimension',
          content: [
            { type: 'instructions', items: [
              { text: 'Add a linear dimension from the Dimensions collection and point it at your box.' },
              { text: 'Pick the Axis (it is required — the editor won’t offer an empty choice) and, if you need one, a tolerance: symmetric asks for one value, asymmetric and limit for two.' },
            ] },
            { type: 'callout', variant: 'info', title: 'Values are derived', body: 'Dimension values are measured from the model — annotate the geometry and the number stays true when the geometry changes.' },
          ],
        },
        {
          id: '2.3',
          title: 'Ask the CAD Modeler',
          content: [
            { type: 'instructions', items: [
              { text: 'Press “Ask the CAD Modeler” in the toolbar and try an example prompt — the assistant reads THIS model first, then renders validated parametric solids into it.' },
              { text: 'Watch the change land in the live view. Not what you wanted? Undo reverts it like any other edit.' },
            ] },
            { type: 'callout', variant: 'info', title: 'One chat, everywhere', body: 'The drawer is the same chat that powers every AI feature here — same provider key, same history, same interrupts — scoped to the CAD Modeler agent.' },
          ],
        },
      ],
    },
  ],
};
