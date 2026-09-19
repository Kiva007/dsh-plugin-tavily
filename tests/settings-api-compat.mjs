/**
 * Settings-seam API compatibility for the shipped artifact.
 *
 * The `@deepseek-ai/dsh-settings` surface this plugin attaches its section
 * through changed incompatibly inside the 0.1.x line:
 *
 *   - up to 0.1.1-rc.2: two standalone exports — `settingsNamespace(name)` and
 *     `installSettingsSection(ctx, ns, schema, entry, hooks)`;
 *   - from 0.1.2-alpha.2 on: both are gone. The same install is a method on the
 *     settings service (`ctx.settings.installSection(owner, ns, schema, entry,
 *     hooks)`) and a namespace is a plain lowercase-kebab string.
 *
 * A *named* import of an export a version dropped is an ESM link error, so a
 * hard switch either way breaks the other era — and the failure mode is the
 * whole plugin failing to load, not a degraded card. This test loads the built
 * `lib/index.mjs` against a real settings package of either era and pins which
 * install path must be taken.
 *
 * Env:
 *   SETTINGS_PACKAGE_DIR  a node_modules directory holding the
 *                         `@deepseek-ai/dsh-settings` to test against
 *                         (default: this repo's own devDependency).
 *
 * Usage:
 *   pnpm build && pnpm run test:settings-api
 *   npm install --prefix /tmp/settings-matrix --no-save @deepseek-ai/dsh-settings@0.1.5-rc.2
 *   SETTINGS_PACKAGE_DIR=/tmp/settings-matrix/node_modules pnpm run test:settings-api
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SETTINGS_NAME = '@deepseek-ai/dsh-settings'
const SETTINGS_PACKAGE_DIR = process.env.SETTINGS_PACKAGE_DIR

// The artifact resolves `@deepseek-ai/dsh-settings` from its own location, so it
// is loaded from a scratch dir whose node_modules carries the target package.
// The scratch dir lives inside the repo on purpose: anything the target package
// (or the artifact) needs beyond the mirror still resolves against the repo's
// devDependencies, exactly like a developer checkout.
const scratch = mkdtempSync(join(REPO, '.settings-api-compat-'))
const scratchModules = join(scratch, 'node_modules')
const mirroredPackage = join(scratchModules, ...SETTINGS_NAME.split('/'))

try {
  if (SETTINGS_PACKAGE_DIR !== undefined) {
    // Mirror the whole prefix — the settings package *and its own dependencies*
    // — so the mirror resolves standalone, the way the CI scratch prefix does.
    cpSync(SETTINGS_PACKAGE_DIR, scratchModules, { recursive: true, dereference: true })
  }
  cpSync(join(REPO, 'lib', 'index.mjs'), join(scratch, 'index.mjs'))

  // Resolved after the mirror: whatever the artifact's own import will find.
  const targetPackage = existsSync(join(mirroredPackage, 'package.json'))
    ? mirroredPackage
    : join(REPO, 'node_modules', ...SETTINGS_NAME.split('/'))
  const targetVersion = JSON.parse(readFileSync(join(targetPackage, 'package.json'), 'utf8')).version

  const settingsModule = await import(
    pathToFileURL(join(targetPackage, 'lib', 'index.js')).href
  )
  const legacyInstall = settingsModule.installSettingsSection

  const plugin = await import(pathToFileURL(join(scratch, 'index.mjs')).href)

  assert.equal(
    plugin.WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE,
    'web-search-tavily',
    'the namespace must stay web-search-tavily on either era',
  )

  const installSectionCalls = []
  const registerCalls = []
  const registered = []
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        registered.push(provider)
      },
      registerFetchProvider() {},
    },
    webServer: { register() {} },
    logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    get: () => undefined,
    effect: () => () => {},
    inject(deps, cb) {
      assert.deepEqual(deps, ['settings'], 'the settings service must be injected')
      cb({
        settings: {
          installSection: (...args) => installSectionCalls.push(args),
          register: (...args) => {
            registerCalls.push(args)
            return { get: () => ({}), watch: () => () => {} }
          },
        },
        effect: () => () => {},
      })
      return () => {}
    },
  }

  const config = { maxResults: 3 }
  plugin.apply(ctx, config)

  if (typeof legacyInstall === 'function') {
    // Legacy era: the standalone helper registers the namespace itself.
    assert.equal(installSectionCalls.length, 0, `${targetVersion} must not use settings.installSection`)
    assert.equal(registerCalls.length, 1, `${targetVersion} must register the section via the legacy helper`)
    assert.equal(registerCalls[0][0], 'web-search-tavily', 'legacy registration keeps the namespace')
  } else {
    // New era: the service method takes the owner ctx plus the same argument list.
    assert.equal(registerCalls.length, 0, `${targetVersion} must not fall back to settings.register`)
    assert.equal(installSectionCalls.length, 1, `${targetVersion} must call settings.installSection once`)
    const [owner, ns, schema, entry, hooks] = installSectionCalls[0]
    assert.equal(owner, ctx, 'owner must be the plugin context')
    assert.equal(ns, 'web-search-tavily', 'the namespace must stay web-search-tavily')
    assert.equal(schema, plugin.Config, 'the schema must be the plugin Config')
    assert.equal(entry, config, 'the entry must be the composition config')
    assert.equal(typeof hooks.setSource, 'function', 'hooks.setSource must be forwarded')
    assert.equal(typeof hooks.onChange, 'function', 'hooks.onChange must be forwarded')
  }

  // The rest of apply() must still have run under either era.
  assert.deepEqual(
    registered.map((provider) => provider.id),
    ['tavily'],
    'the Tavily search provider must still register into ctx.web',
  )

  const era = typeof legacyInstall === 'function' ? 'legacy helper' : 'settings.installSection'
  console.log(`settings-api-compat: ok — dsh-settings ${targetVersion} attaches via the ${era}`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
