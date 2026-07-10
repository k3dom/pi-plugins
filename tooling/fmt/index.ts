import { defineConfig } from 'oxfmt'

export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 85,
  proseWrap: 'always',
  ignorePatterns: ['**/CHANGELOG.md', '.changeset/*.md'],
  sortImports: {
    newlinesBetween: false,
  },
})
