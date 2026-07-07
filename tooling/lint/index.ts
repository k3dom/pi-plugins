import { defineConfig } from 'oxlint'

export default defineConfig({
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    perf: 'warn',
  },
  plugins: ['oxc', 'typescript', 'unicorn', 'import'],
  rules: {
    curly: ['error', 'all'],
    // `_tag` is the idiomatic discriminant of Effect's tagged types.
    'no-underscore-dangle': 'off',
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
})
