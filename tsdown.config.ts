import { defineConfig } from 'tsdown'

/**
 * Two entries, matching the two things this package is:
 *
 *   - `lib/index.js` — the Cordis plugin the Host loads
 *   - `lib/bin.js`   — the CLI (`dsh plugin … exec dsh-connect-workbuddy-autocheckin`)
 *
 * `dsh-connect-workbuddy` is EXTERNAL: it is a peer dependency provided by the
 * profile, and bundling a copy would give this plugin its own private credential
 * store and upstream client — two things that must be the same instance the base
 * plugin uses, or a refresh here would not be seen there.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  // `.js`, not tsdown's default `.mjs`: package.json's `main`, `bin`, and
  // `exports` all name `lib/*.js`, matching the base plugin's layout. The
  // package is `"type": "module"`, so a `.js` file is still ESM.
  outExtensions: () => ({ js: '.js' }),
  external: ['dsh-connect-workbuddy', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
})
