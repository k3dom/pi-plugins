import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    const hasExtension = /\.[^/]+$/u.test(specifier)
    return isRelative && !hasExtension
      ? nextResolve(`${specifier}.ts`, context)
      : nextResolve(specifier, context)
  },
})
