// The session token in the iOS Keychain.
//
// Why Objective-C and not Rust: a reader's GReader token belongs in the Keychain,
// and the Keychain is Security framework — no Rust crate in this app's dependency
// set reaches it, and a Swift file is the only other way in. `secrets.rs` calls the
// four symbols below from the other side of the FFI; `+load` is not needed here
// (unlike StatusBar.m), so this is plain C functions and one string constant.
//
// Four rules, and each of them is a way a store build goes wrong:
//
// - **`ThisDeviceOnly`**: a token must not ride a device backup to another phone.
//   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the pairing that lets a
//   background refresh read it and stops it migrating.
// - **A write replaces, it does not add twice.** `SecItemDelete` then `SecItemAdd`
//   is the update path that works whether or not the item existed.
// - **`get` answers an allocated string, and the caller frees it.** Rust owns the
//   memory via `hr_keychain_free`; returning a static buffer would be faster and a
//   use-after-free waiting to happen.
// - **A missing item is not an error** — `get` returns NULL, `delete` returns 1.
//   `errSecItemNotFound` is what a fresh install looks like.
//
// The marker string is grepped out of the built binary by both IPA pipelines: a
// native file that never entered the app target produces a perfectly successful
// build that stores nothing.

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <stdlib.h>
#import <string.h>

__attribute__((used)) static NSString *const HRKeychainMarker = @"hardlyreader-keychain-1";

static NSString *const HRKeychainService = @"hardlyreader.session";

/// The query every operation starts from. Accountable per key, so two accounts on
/// one device are two items rather than one that keeps being overwritten.
static NSMutableDictionary *HRQuery(NSString *key) {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : HRKeychainService,
    (__bridge id)kSecAttrAccount : key,
  } mutableCopy];
}

/// 1 when the item is now in the Keychain, 0 when it is not.
int hr_keychain_set(const char *key, const char *value) {
  if (key == NULL || value == NULL) {
    return 0;
  }
  @autoreleasepool {
    NSString *account = [NSString stringWithUTF8String:key];
    NSData *secret = [[NSString stringWithUTF8String:value]
        dataUsingEncoding:NSUTF8StringEncoding];
    if (account == nil || secret == nil) {
      return 0;
    }
    NSMutableDictionary *query = HRQuery(account);
    // Replace rather than duplicate: a re-login writes a new token for the same
    // account by definition.
    SecItemDelete((__bridge CFDictionaryRef)query);
    [query setObject:secret forKey:(__bridge id)kSecValueData];
    [query setObject:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
              forKey:(__bridge id)kSecAttrAccessible];
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
    return status == errSecSuccess ? 1 : 0;
  }
}

/// A NUL-terminated copy the caller frees with `hr_keychain_free`, or NULL.
char *hr_keychain_get(const char *key) {
  if (key == NULL) {
    return NULL;
  }
  @autoreleasepool {
    NSString *account = [NSString stringWithUTF8String:key];
    if (account == nil) {
      return NULL;
    }
    NSMutableDictionary *query = HRQuery(account);
    [query setObject:(__bridge id)kCFBooleanTrue forKey:(__bridge id)kSecReturnData];
    [query setObject:(__bridge id)kSecMatchLimitOne forKey:(__bridge id)kSecMatchLimit];
    CFTypeRef found = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    if (status != errSecSuccess || found == NULL) {
      return NULL;
    }
    NSData *data = (__bridge_transfer NSData *)found;
    NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (value == nil) {
      return NULL;
    }
    const char *utf8 = [value UTF8String];
    if (utf8 == NULL) {
      return NULL;
    }
    size_t length = strlen(utf8);
    char *copy = (char *)malloc(length + 1);
    if (copy == NULL) {
      return NULL;
    }
    memcpy(copy, utf8, length + 1);
    return copy;
  }
}

/// Frees what `hr_keychain_get` returned.
void hr_keychain_free(char *value) {
  if (value != NULL) {
    free(value);
  }
}

/// 1 when the item is gone (or never existed), 0 when the Keychain refused.
int hr_keychain_delete(const char *key) {
  if (key == NULL) {
    return 0;
  }
  @autoreleasepool {
    NSString *account = [NSString stringWithUTF8String:key];
    if (account == nil) {
      return 0;
    }
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)HRQuery(account));
    return (status == errSecSuccess || status == errSecItemNotFound) ? 1 : 0;
  }
}
