//! Unit tests for the Iwa reputation verifier.
//!
//! These feed the REAL proof generated in Stage 8 (good member) and confirm the
//! contract returns `true`, then feed a tampered public claim and a corrupted
//! proof and confirm it returns `false`. All byte artifacts under `testdata/`
//! are produced by `testdata/convert.js` from the Stage 7/8 snarkjs output.

use super::*;
use soroban_sdk::{testutils::BytesN as _, Bytes, BytesN, Env, Vec};

const PROOF_PASS: &str = include_str!("../testdata/proof_pass.hex");
const PROOF_TAMPERED: &str = include_str!("../testdata/proof_tampered.hex");
const PUBLIC_PASS: &str = include_str!("../testdata/public_pass.json");
const PUBLIC_TAMPERED: &str = include_str!("../testdata/public_tampered.json");

fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("non-hex char"),
    }
}

/// Collect hex nibbles from `s` (ignoring any non-hex punctuation), returning
/// the decoded bytes.
fn hex_decode(s: &str) -> alloc::vec::Vec<u8> {
    let nibbles: alloc::vec::Vec<u8> = s
        .bytes()
        .filter(|c| c.is_ascii_hexdigit())
        .map(hex_nibble)
        .collect();
    assert!(nibbles.len() % 2 == 0, "odd hex length");
    nibbles.chunks(2).map(|p| (p[0] << 4) | p[1]).collect()
}

fn proof_bytes(env: &Env, hex: &str) -> Bytes {
    Bytes::from_slice(env, &hex_decode(hex))
}

/// Parse a JSON array of 32-byte hex strings into `Vec<BytesN<32>>`.
fn signals(env: &Env, json: &str) -> Vec<BytesN<32>> {
    let raw = hex_decode(json); // concatenation of 32-byte signals
    assert!(raw.len() % 32 == 0, "signals not a multiple of 32 bytes");
    let mut out = Vec::new(env);
    for chunk in raw.chunks(32) {
        let mut buf = [0u8; 32];
        buf.copy_from_slice(chunk);
        out.push_back(BytesN::from_array(env, &buf));
    }
    out
}

#[test]
fn good_member_proof_verifies() {
    let env = Env::default();
    let proof = proof_bytes(&env, PROOF_PASS);
    let public = signals(&env, PUBLIC_PASS);
    assert!(
        IwaReputationVerifier::verify_proof(env.clone(), proof, public),
        "the real Stage 8 good-member proof must verify true"
    );
}

#[test]
fn tampered_public_claim_fails() {
    // Same valid proof, but the public claim (threshold 2 -> 5) no longer
    // matches what was proven: verification must reject.
    let env = Env::default();
    let proof = proof_bytes(&env, PROOF_PASS);
    let public = signals(&env, PUBLIC_TAMPERED);
    assert!(
        !IwaReputationVerifier::verify_proof(env.clone(), proof, public),
        "a tampered public claim must verify false"
    );
}

#[test]
fn corrupted_proof_fails() {
    // The proof bytes themselves are corrupted (one byte flipped): reject.
    let env = Env::default();
    let proof = proof_bytes(&env, PROOF_TAMPERED);
    let public = signals(&env, PUBLIC_PASS);
    assert!(
        !IwaReputationVerifier::verify_proof(env.clone(), proof, public),
        "a corrupted proof must verify false"
    );
}

#[test]
fn wrong_signal_count_fails() {
    // The circuit has exactly 3 public signals; anything else is malformed.
    let env = Env::default();
    let proof = proof_bytes(&env, PROOF_PASS);
    let mut public = signals(&env, PUBLIC_PASS);
    public.push_back(BytesN::random(&env));
    assert!(
        !IwaReputationVerifier::verify_proof(env.clone(), proof, public),
        "wrong public-signal count must verify false"
    );
}

#[test]
fn malformed_proof_length_fails() {
    let env = Env::default();
    let short = Bytes::from_slice(&env, &[0u8; 100]);
    let public = signals(&env, PUBLIC_PASS);
    assert!(
        !IwaReputationVerifier::verify_proof(env.clone(), short, public),
        "a proof of wrong length must verify false"
    );
}
