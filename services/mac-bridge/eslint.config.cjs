const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: __dirname
      }
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error'
    }
  },
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-misused-promises': 'off'
    }
  }
];
