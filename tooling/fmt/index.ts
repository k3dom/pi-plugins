import { defineConfig } from 'oxfmt'

export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 85,
  proseWrap: 'always',
  sortImports: {
    newlinesBetween: false,
  },
})
