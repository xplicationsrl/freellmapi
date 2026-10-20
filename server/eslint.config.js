import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // Production code is free of explicit `any`: untrusted shapes (provider
      // JSON, caught errors, content blocks) are `unknown` and narrowed, or read
      // through typed helpers (lib/error-props, lib/stream-frame). Keep it that
      // way; tests are exempt below because fixtures routinely cast.
      '@typescript-eslint/no-explicit-any': 'error',
      // Standard test-scaffolding conventions: `_`-prefixed names are
      // intentionally unused, and empty catch blocks assert error paths.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
])
