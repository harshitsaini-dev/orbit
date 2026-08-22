// @ts-check
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for the monorepo.
 *
 * The point of this file is not style — `tsc --build` already rejects most of
 * what a linter would catch, and formatting is not worth arguing with a tool
 * about. It is here for the class of mistake TypeScript compiles happily:
 * a promise nobody awaited, a `catch` that swallows the error, a hook whose
 * dependency list has quietly drifted from what it reads.
 *
 * Type-aware rules are on for source files, because the ones worth having
 * (`no-floating-promises` above all) cannot work without types. Config files and
 * scripts are linted without a project, which keeps them from having to appear
 * in a tsconfig just to be checked.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and the generated brand assets. Nothing here
    // was written by hand, so nothing here is worth an opinion.
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/public/**',
      // Generated service worker and its workbox runtime.
      'apps/web/dev-dist/**',
      'packages/db/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // TypeScript already reports an unknown identifier, and it knows about
      // ambient and lib types that this rule does not - it only ever produces
      // false positives here.
      'no-undef': 'off',
    },
  },

  // --- source, with types ---------------------------------------------------
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The rule this config exists for. An un-awaited promise in a route
       * handler is a request that returns before its work is done and an error
       * that reaches no handler — and it compiles perfectly.
       *
       * `void` is accepted as the deliberate form, which is what the codebase
       * already uses for fire-and-forget.
       */
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          /**
           * `describe` and `it` from node:test return promises that the runner
           * owns. Awaiting them is wrong and `void`-ing every one of several
           * hundred would be noise, so they are named as safe here rather than
           * the rule being weakened for test files - which is where an actually
           * un-awaited promise is easiest to write and hardest to notice.
           */
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite'] },
          ],
        },
      ],
      /**
       * `checksVoidReturn` is off for both arguments and attributes.
       *
       * An async Express handler is the shape every route in this codebase
       * uses, and Express 4 does not await it - which the rule is right to
       * point out in general. Here every handler wraps its body in try/catch
       * and hands the error to `next`, so the failure the rule guards against
       * is already handled by convention, and reporting it fifty times would
       * only teach people to stop reading the output.
       *
       * An async function passed as a React event handler is likewise ordinary.
       *
       * The valuable half of this rule - a promise used where a boolean or a
       * conditional is expected, which is always a bug - is still on.
       */
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      // `_`-prefixed arguments are the established way of saying "required by
      // the signature, unused here" throughout this codebase.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      /**
       * Off, deliberately. Provider responses arrive as `any` from `res.json()`
       * and are narrowed by hand at the adapter boundary; turning every one of
       * those into an error would mean either a lie of a type assertion or a
       * suppression comment on each, and neither is safer than what is there.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Template literals carrying a number or a boolean are ordinary and
      // reporting them says nothing useful.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      // A non-null assertion is a claim the compiler cannot check, but
      // `req.params.id!` after a route matched it is a true claim.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // An empty catch is how "this failing is fine" gets written, and it is
      // indistinguishable from having forgotten to handle it. Say so instead.
      'no-empty': ['error', { allowEmptyCatch: false }],

      /**
       * Off. `ProviderAdapter` declares its methods as returning promises, and
       * an adapter that can answer without awaiting anything - S3 has no token
       * to refresh, several `getQuota` implementations are pure arithmetic -
       * still has to satisfy the signature. The rule would have each of them
       * either fake an await or carry a suppression comment.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },

  // --- the browser ----------------------------------------------------------
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    settings: { react: { version: 'detect' } },
    plugins: { 'react-hooks': reactHooks, react, 'jsx-a11y': jsxA11y },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The new JSX transform: no React import is needed to use JSX, and
      // prop-types are what TypeScript replaced.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      /**
       * Warnings, not errors. These come from the React Compiler's rule set and
       * describe patterns that are usually worth reconsidering but sometimes
       * correct - resetting state when a prop changes is the documented way to
       * do that, and it is what most of the twenty-five current reports are.
       * They are worth seeing; they are not worth failing a build over until
       * each has actually been looked at.
       */
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',

      /**
       * The rule cannot see inside a component, so a `<label>` wrapping this
       * project's `Checkbox` - which renders a real, visually-hidden `<input>` -
       * reads to it as a label with no control. Naming them restores the check
       * for every other case.
       */
      'jsx-a11y/label-has-associated-control': [
        'error',
        // `either`: a label is fine whether it wraps its control or points at
        // it by id. Both forms are used here and both are correct.
        {
          assert: 'either',
          controlComponents: ['Checkbox', 'Select', 'Toggle'],
          // The radio labels in AllocationSettings put their text inside a
          // wrapper span so the name and the blurb can be styled apart; the
          // default depth of 2 stops short of it and reports a label that
          // plainly has text.
          depth: 4,
        },
      ],
      /**
       * A dependency array that has drifted from what the effect reads is the
       * single most common React bug in this codebase's history — a thumbnail
       * that never reloads when the file changes, a listing that keeps showing
       * the previous folder. An error, not a warning.
       */
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // --- the server -----------------------------------------------------------
  {
    files: ['apps/server/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // --- tests ----------------------------------------------------------------
  {
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'apps/server/src/test-utils.ts'],
    rules: {
      // A test stubbing an adapter method reaches through the type on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // --- config and scripts, without a project --------------------------------
  {
    files: ['*.{js,mjs,ts}', 'scripts/**/*.mjs', '**/*.config.{js,ts,mjs}'],
    languageOptions: {
      // Both, because the brand script is a Node program whose page.evaluate
      // callbacks are serialised and run in a real browser.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
);
