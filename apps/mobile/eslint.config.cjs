const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.expo/**']
  },
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error'
    }
  },
  {
    files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-misused-promises': 'off'
    }
  }
];
