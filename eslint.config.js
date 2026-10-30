import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  // Keep base TS rules global, but type-aware rules only for TS sources/tests.
  ...tseslint.configs.recommended,
  prettier,
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: ['src/**/*.ts', 'tests/**/*.ts', 'web/src/**/*.{ts,tsx}', 'web/vite.config.ts'],
  })),
  {
    // The web dashboard (web/) has its own tsconfig and packages, same rules.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'web/src/**/*.{ts,tsx}', 'web/vite.config.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      // Enterprise defaults: keep types explicit & codebase clean.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Unused code is a liability in audited systems.
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],

      // Deterministic, readable imports.
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
        },
      ],
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
    },
  },
  {
    // Production code logs through pino (src/shared/log.ts or the injected logger): structured,
    // levelled and redacted. Command-line tools in src/devtools may print to the console.
    files: ['src/**/*.ts'],
    ignores: ['src/devtools/**'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'web/dist/**', 'web/node_modules/**'],
  },
];
