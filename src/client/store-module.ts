/**
 * The snapshot-store factory across the client module-table rename.
 *
 * The client half externalizes its dependencies onto the harness's browser
 * module table, and that table's vocabulary changed with the settings seam:
 * `createSnapshotStore` arrived as `@deepseek-ai/dsh-client-runtime/client` up
 * to dsh 0.1.1-rc.2 and as `@deepseek-ai/dsh-client-store` from the 0.1.2 line
 * on — the shell bundle seeds the new specifier (`dsh-client-runtime` is no
 * longer part of the platform at all) and no built-in client bundle requires
 * the old one any more. A require the table cannot answer throws, and that
 * throw fails the *whole* plugin entry, so the bundle probes the current
 * specifier and falls back to the legacy one rather than picking a side.
 *
 * Both packages export the same factory with the same signature —
 * `createSnapshotStore<T>(init, opts?) => SnapshotStore<T>` — and the store's
 * `getSnapshot`/`subscribe`/`set`/`update` face is unchanged between them.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The slice of the store module this bundle consumes. */
export interface SnapshotStoreModule {
  /** Writable snapshot store factory (identical in both eras). */
  createSnapshotStore: <T>(init: T, opts?: { flush?: 'raf'; persist?: { name: string } }) => SnapshotStore<T>
}

// Held in variables on purpose: the loader answers these specifiers itself, so
// the bundler must keep both requires dynamic. A statically resolvable
// specifier could be inlined, and an inlined copy is exactly what the module
// table exemption exists to prevent.
const CURRENT_STORE_MODULE = '@deepseek-ai/dsh-client-store'
const LEGACY_STORE_MODULE = '@deepseek-ai/dsh-client-runtime/client'

let resolved: SnapshotStoreModule | undefined

/**
 * Resolve the store module from the harness module table.
 * @returns the module whose `createSnapshotStore` this bundle uses.
 * @throws when neither the current nor the legacy specifier carries the factory.
 */
export function loadStoreModule(): SnapshotStoreModule {
  if (resolved !== undefined) return resolved
  const failures: string[] = []
  for (const specifier of [CURRENT_STORE_MODULE, LEGACY_STORE_MODULE]) {
    try {
      const candidate = require(specifier) as Partial<SnapshotStoreModule> | undefined
      if (typeof candidate?.createSnapshotStore === 'function') {
        resolved = candidate as SnapshotStoreModule
        return resolved
      }
      failures.push(`${specifier}: no createSnapshotStore export`)
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`[dsh-plugin-tavily] client snapshot store unavailable — ${failures.join('; ')}`)
}
