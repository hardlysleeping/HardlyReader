/**
 * The app's version, for the About section.
 *
 * Read from the package manifest rather than written a second time: a version
 * string copied into a component is a version string that is wrong one release
 * later, and the panel is the one place a person looks to check which build
 * they are running. `resolveJsonModule` is on, so the import is typed and the
 * bundler inlines it.
 */
import manifest from "../../package.json" with { type: "json" };

/** The version this build was made from, as `package.json` states it. */
export const APP_VERSION: string = manifest.version;
