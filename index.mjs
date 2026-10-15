import plugin from "./provider.mjs"

// Only the `server` factory is forwarded: that is the hook a magpie host builds
// a plugin from, so the provider's `id` is deliberately not repeated here. Say
// so where the mismatch is, rather than handing the host an undefined plugin to
// fail with something opaque later.
if (typeof plugin?.server !== "function") {
  throw new TypeError("provider.mjs must default-export a plugin with a `server` factory")
}

export const ZenFreePlugin = plugin.server
