/**
 * Registers the TypeScript resolve hook for unit tests.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/hardlyread-api.mjs
 */
import { register } from "node:module";

register(new URL("./ts-resolve.mjs", import.meta.url));
