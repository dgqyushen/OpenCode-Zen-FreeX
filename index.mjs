import plugin from "./provider.mjs"

// A host resolves a plugin module and reads the factory off it. Which shape it
// reads is the host's business and not this package's to narrow: magpie builds
// one from `default.server`, which is the shape provider.mjs already exports, so
// that object is forwarded whole rather than the factory being renamed into a
// shape nothing else in the package uses. The `id` comes with it, because a
// loader that keys plugins by id needs the same one the provider registers — and
// it is the provider's own id, not a second copy of it: it is read from the
// module, so the two cannot drift.
//
// The named export stays for anything that already imported it by name, and
// `server` is offered as a name too, so `mod.default.server` and `mod.server`
// both resolve. Both halves of what the object carries are checked here, the
// `id` as well as the factory: a provider.mjs that lost either one would
// otherwise load cleanly and hand the host a plugin it cannot key or start.
if (typeof plugin?.server !== "function" || typeof plugin?.id !== "string" || !plugin.id) {
  throw new TypeError(
    "provider.mjs must default-export a plugin with a `server` factory and an `id`",
  )
}

export const ZenFreePlugin = plugin.server
export const server = plugin.server
export default plugin
