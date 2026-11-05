/**
 * Where the HardlyReader account's record lives on this device.
 *
 * Its own module, with no imports, because two very different readers need the
 * key and neither should drag the other's machinery along: `api/identity` owns
 * the record (token, providers, expiry), and `lib/settings-scope` needs only the
 * `userId` inside it to decide whose settings these are. Importing the identity
 * module for one constant would load a client and a transport into every store
 * that asks, and a settings store must not depend on the network.
 *
 * One key, defined once: a rename here cannot leave a reader looking at a key
 * nobody writes.
 */
export const IDENTITY_KEY = "hardlyreader.identity.v1";
