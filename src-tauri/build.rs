fn main() {
    // On iOS one symbol in this crate is defined outside it: `hardlyreader_share`
    // lives in `src-tauri/ios/ShareSheet.swift`, which is compiled into the app
    // target rather than into this library (see the Codemagic workflow, "Add the
    // native share bridge"). Cargo still links `libhardlyreader_lib` as a dylib —
    // an artefact nothing loads on iOS, because the Xcode project links the
    // staticlib through LIBRARY_SEARCH_PATHS — and that link cannot see the Swift
    // object, so it fails with "Undefined symbols: _hardlyreader_share".
    //
    // Let the linker leave it undefined here; it is resolved for real when Xcode
    // links the app, where both halves are in the same image.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
    tauri_build::build()
}
