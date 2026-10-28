//! Standard base64, decoded by hand.
//!
//! The only base64 the binary ever decodes is a sync archive on its way to
//! `files::save_bytes`: a Tauri command's arguments arrive as JSON, and a
//! `Uint8Array` does not survive that trip, so the webview hands over the zip as
//! text. Twenty lines beat a crate here — a dependency is a thing to keep
//! patched, and this one would exist for one call.
//!
//! It is a file of its own rather than a private function in `files.rs` for one
//! reason: this box cannot compile the Tauri crate (its system libraries are not
//! installed) but it can compile and test anything that only uses `std`, so the
//! decoder is provable here and `files.rs` stays a thin wrapper.

/// Decodes standard base64 with padding.
///
/// Whitespace is tolerated — a wrapped line is still a line — and everything
/// else is refused with a sentence rather than decoded into rubbish, because the
/// bytes become a file the reader keeps.
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut block = [0u8; 4];
    let mut filled = 0;
    let mut padding = 0;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return Err(INVALID.into());
        }
        let value = sextet(byte).ok_or_else(|| INVALID.to_string())?;
        block[filled] = value;
        filled += 1;
        if filled == 4 {
            out.push((block[0] << 2) | (block[1] >> 4));
            out.push((block[1] << 4) | (block[2] >> 2));
            out.push((block[2] << 6) | block[3]);
            filled = 0;
        }
    }

    match (filled, padding) {
        // A whole number of blocks, and no padding.
        (0, 0) => Ok(out),
        // Two sextets and two pads: one byte.
        (2, 2) => {
            out.push((block[0] << 2) | (block[1] >> 4));
            Ok(out)
        }
        // Three sextets and one pad: two bytes.
        (3, 1) => {
            out.push((block[0] << 2) | (block[1] >> 4));
            out.push((block[1] << 4) | (block[2] >> 2));
            Ok(out)
        }
        _ => Err(INVALID.into()),
    }
}

const INVALID: &str = "That archive's bytes are not valid base64.";

#[cfg(test)]
mod tests {
    use super::*;

    /// A zip begins `PK\x03\x04`, which makes a byte test legible.
    #[test]
    fn it_decodes_the_bytes_a_zip_starts_with() {
        // "PK\x03\x04": the local file header's signature, and the first thing
        // in every archive this app writes.
        assert_eq!(
            decode("UEsDBA==").expect("two sextets and two pads"),
            vec![0x50, 0x4b, 0x03, 0x04]
        );
        assert_eq!(
            decode("UEsDBAo=").expect("three sextets and one pad"),
            vec![0x50, 0x4b, 0x03, 0x04, 0x0a]
        );
        assert_eq!(
            decode("UEsDBAoA").expect("a whole block"),
            vec![0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]
        );
        assert_eq!(decode("").expect("nothing"), Vec::<u8>::new());
        assert_eq!(decode("/w==").expect("the top of the alphabet"), vec![0xff]);
    }

    #[test]
    fn it_tolerates_whitespace_and_refuses_rubbish() {
        assert_eq!(
            decode("UEsD\nBAoA\n").expect("a wrapped file"),
            vec![0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]
        );
        assert!(decode("UEsD*A==").is_err(), "a stray character was accepted");
        assert!(decode("U").is_err(), "a lone sextet was accepted");
        assert!(decode("U=").is_err(), "a bad pad was accepted");
        assert!(decode("UE=A").is_err(), "a pad in the middle was accepted");
        assert_eq!(
            decode("UEsD*A==").expect_err("a stray character"),
            INVALID,
            "the sentence a reader sees"
        );
    }
}
