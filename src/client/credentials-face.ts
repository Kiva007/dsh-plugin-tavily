/**
 * The credentials client face across the connection → remote move.
 *
 * Up to dsh 0.1.1-rc.x a card reached the credentials domain through the
 * connection handle — `connection.api.credentials.describe({ refs })` and
 * `.set({ ref, value })`, answers wrapped as
 * `{ result: { ok, value: { credentials } } }`. From the 0.1.2 line the domain
 * is a remote namespace — `ctx.remote.credentials.describe([ref])` and
 * `.set(ref, value)` with `{ ok, value }` answers — and `connection.api` is gone
 * there, so the legacy call throws. That throw lands inside a save, where the
 * card can only report "the deployment did not accept these values", and inside
 * a credential read, where it silently keeps reporting "no key configured".
 *
 * Both faces answer the same two facts (configured / writable) and carry the
 * same write, so this normalizes argument and answer shapes behind one
 * interface. The namespace half is *adopted* rather than imported: a cordis
 * plugin may only read `ctx.remote.credentials` after declaring it, and
 * declaring it globally would park the whole plugin on harnesses that have no
 * such namespace — so the entry injects it dynamically and hands it here, and
 * the legacy face serves every harness where it never appears.
 *
 * The host stays the only authority on whether a credential exists: with no
 * face adopted every call rejects, so callers keep their last known state
 * instead of inventing one.
 */

/** One reference's state, as every credentials surface reports it. */
export interface CredentialView {
  /** Whether the host holds a value for the reference. */
  configured: boolean
  /** Whether the host accepts a write for the reference. */
  writable: boolean
}

/** The credentials domain as a card consumes it. */
export interface CredentialsFace {
  /**
   * Read one reference.
   * @param ref - credential reference name (for example `TAVILY_API_KEY`).
   * @returns the reference's state, or undefined when the domain reports none.
   */
  describe(ref: string): Promise<CredentialView | undefined>
  /**
   * Write one credential literal.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   */
  set(ref: string, value: string): Promise<void>
}

/** A face that learns which surface the running harness exposes. */
export interface CredentialsFaceHandle extends CredentialsFace {
  /**
   * Adopt the current `remote.credentials` namespace.
   * @param namespace - the injected namespace, or undefined to leave it unset.
   */
  adoptRemoteNamespace(namespace: unknown): void
  /**
   * Adopt the legacy `connection.api.credentials` face.
   * @param namespace - the handle's credentials face, or undefined.
   */
  adoptLegacyNamespace(namespace: unknown): void
}

/** `ctx.remote.credentials` — the current namespace face. */
interface RemoteCredentialsNamespace {
  describe(refs: readonly string[]): Promise<{ ok: boolean; value?: Record<string, CredentialView | undefined> }>
  set(ref: string, value: string): Promise<unknown>
}

/** `connection.api.credentials` — the legacy handle face. */
interface LegacyCredentialsNamespace {
  describe(args: { refs: readonly string[] }): Promise<{
    result: { ok: boolean; value?: { credentials: Record<string, CredentialView | undefined> } }
  }>
  set(args: { ref: string; value: string }): Promise<unknown>
}

/** Narrow an adopted value to a usable namespace, or undefined. */
function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/**
 * Create the face the card writes through.
 * @returns the handle, before either surface has been adopted.
 */
export function createCredentialsFace(): CredentialsFaceHandle {
  let remote: RemoteCredentialsNamespace | undefined
  let legacy: LegacyCredentialsNamespace | undefined

  return {
    adoptRemoteNamespace(namespace) {
      const candidate = namespace as RemoteCredentialsNamespace | undefined
      if (candidate !== undefined && isFunction(candidate.describe) && isFunction(candidate.set)) remote = candidate
    },
    adoptLegacyNamespace(namespace) {
      const candidate = namespace as LegacyCredentialsNamespace | undefined
      if (candidate !== undefined && isFunction(candidate.describe) && isFunction(candidate.set)) legacy = candidate
    },
    async describe(ref) {
      if (remote !== undefined) {
        const response = await remote.describe([ref])
        return response.ok ? response.value?.[ref] : undefined
      }
      if (legacy !== undefined) {
        const { result } = await legacy.describe({ refs: [ref] })
        return result.ok ? result.value?.credentials?.[ref] : undefined
      }
      throw new Error('[dsh-plugin-tavily] no credentials surface is available on this harness')
    },
    async set(ref, value) {
      if (remote !== undefined) {
        await remote.set(ref, value)
        return
      }
      if (legacy !== undefined) {
        await legacy.set({ ref, value })
        return
      }
      throw new Error('[dsh-plugin-tavily] no credentials surface is available on this harness')
    },
  }
}
