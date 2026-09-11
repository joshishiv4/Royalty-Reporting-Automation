import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scratchpad/**', 'scratchpad-*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Secrets must never reach stdout by accident.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/cli/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['*.config.js', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Operator scripts are plain .mjs, deliberately outside the typechecked
    // build: they are run by hand from a clone, not compiled or imported. The
    // spread has to be merged rather than replaced, or the rules it switches
    // off come straight back on. no-console is off because printing IS the job.
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // The earlier block turns the project service on for everything; these
      // files are not in any tsconfig, so it has to be turned back off here or
      // every one of them fails to parse.
      parserOptions: { projectService: false, project: false },
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
  },
);
