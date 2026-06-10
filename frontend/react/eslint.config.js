// ESLint flat config (GAP-ANALYSIS F3) — RATCHETED TO ERROR.
//
// History: this started warn-first to exit clean against a backlog. That
// backlog is now cleared (frontend enterprise-review, Batch C), so the
// type-safety, hooks-correctness, and accessibility rules below are promoted
// to "error" and `npm run lint` is wired into CI as blocking
// (`lint -- --max-warnings=0`). Keep new rules warn-first until their category
// is clean, then promote here. The inline-color / CSS-token gates stay the
// dedicated check-*.mjs scripts in package.json `build`.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'scripts/**', '*.config.{js,ts}'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      // Suppression / type-safety discipline (DESIGN.md) — backlog cleared,
      // now enforced as errors.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // console.* should be intentional; the few diagnostic sites carry an
      // explicit eslint-disable. Enabling the rule makes those directives
      // meaningful (not "unused") and flags stray logging.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Hooks correctness — the highest-value lint for this codebase.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Accessibility essentials (App-UI a11y).
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      // DESIGN.md: no emoji used as icons — use the Lucide ui/icons set.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "JSXText[value=/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u]",
          message: 'No emoji as icons (DESIGN.md) — use a ui/icons Lucide icon.',
        },
      ],
    },
  },
);
