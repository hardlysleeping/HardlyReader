/**
 * Node ESM resolve hook for this repo's TypeScript sources.
 *
 * The app is built by Vite, so its imports are extensionless
 * (`from "./freshrss"`). Node's own resolver needs an extension, so a relative
 * specifier that fails to resolve is retried with `.ts`, then `/index.ts`.
 *
 * Used only by the unit tests; never shipped.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") || /\.[cm]?[jt]s$/.test(specifier)) {
      throw error;
    }
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      return next(`${specifier}/index.ts`, context);
    }
  }
}
