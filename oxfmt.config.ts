import base from '@pi-plugins/fmt'
import { defineConfig } from 'oxfmt'

export default defineConfig({
  ...base,
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    'packages',
    '.agents',
    'flake.lock',
  ],
})
