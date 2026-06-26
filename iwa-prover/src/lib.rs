//! Iwa browser/WASM prover for the reputation circuit.
//!
//! Generates a real Groth16 (BN254) proof entirely on-device. The member's
//! secret and reputation numbers are turned into a circuit witness in JS (using
//! circom's witness calculator), then this module produces the proof with
//! arkworks. Nothing here talks to a server: the secret never leaves the device.
//!
//! Pattern studied from the Nethermind reference prover (arkworks, not snarkjs),
//! but targeted at our own reputation circuit. We load the proving key from the
//! Stage 7 snarkjs `.zkey` via `read_zkey`, so the same Stage 7 verification key
//! verifies the resulting proof.

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_circom::{read_zkey, CircomReduction};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{Groth16, Proof, VerifyingKey};
use ark_snark::SNARK;
use ark_std::UniformRand;
use rand::rngs::OsRng;
use num_bigint::BigUint;
use serde_json::Value;
use std::io::Cursor;

// ---- decimal <-> field helpers -------------------------------------------

fn fr_from_dec(s: &str) -> Result<Fr, String> {
    let bu = BigUint::parse_bytes(s.as_bytes(), 10).ok_or("invalid decimal")?;
    Ok(Fr::from_be_bytes_mod_order(&bu.to_bytes_be()))
}

fn fq_from_value(v: &Value) -> Result<Fq, String> {
    let s = v.as_str().ok_or("field element must be a string")?;
    let bu = BigUint::parse_bytes(s.as_bytes(), 10).ok_or("invalid decimal")?;
    Ok(Fq::from_be_bytes_mod_order(&bu.to_bytes_be()))
}

fn fp_to_dec<P: PrimeField>(x: &P) -> String {
    BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()).to_string()
}

// ---- proving --------------------------------------------------------------

/// Generate a Groth16 proof from the circuit's full witness.
///
/// `zkey_bytes` is the Stage 7 snarkjs proving key (.zkey). `witness_json` is a
/// JSON array of decimal strings (the full witness, leading "1" included), as
/// produced by circom's witness calculator. Returns a JSON string with the
/// proof points and the public signals.
pub fn prove_inner(zkey_bytes: &[u8], witness_json: &str) -> Result<String, String> {
    let witness_vals: Vec<String> =
        serde_json::from_str(witness_json).map_err(|e| format!("witness json: {e}"))?;
    let witness: Vec<Fr> = witness_vals
        .iter()
        .map(|s| fr_from_dec(s))
        .collect::<Result<_, _>>()?;

    let mut cursor = Cursor::new(zkey_bytes);
    let (pk, matrices) = read_zkey(&mut cursor).map_err(|e| format!("read_zkey: {e}"))?;
    let num_inputs = matrices.num_instance_variables;
    let num_constraints = matrices.num_constraints;
    // ark-groth16 wants the matrices as a slice [A, B, C].
    let mats = [matrices.a, matrices.b, matrices.c];

    let mut rng = OsRng;
    let r = Fr::rand(&mut rng);
    let s = Fr::rand(&mut rng);

    let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
        &pk, r, s, &mats, num_inputs, num_constraints, &witness,
    )
    .map_err(|e| format!("prove: {e}"))?;

    let n_pub = pk.vk.gamma_abc_g1.len() - 1;
    if witness.len() <= n_pub {
        return Err("witness shorter than public input count".into());
    }
    let public: Vec<String> = (1..=n_pub).map(|i| fp_to_dec(&witness[i])).collect();

    let out = serde_json::json!({
        "proof": {
            "a": [fp_to_dec(&proof.a.x), fp_to_dec(&proof.a.y)],
            "b": [
                [fp_to_dec(&proof.b.x.c0), fp_to_dec(&proof.b.x.c1)],
                [fp_to_dec(&proof.b.y.c0), fp_to_dec(&proof.b.y.c1)]
            ],
            "c": [fp_to_dec(&proof.c.x), fp_to_dec(&proof.c.y)]
        },
        "publicSignals": public
    });
    Ok(out.to_string())
}

// ---- verification ---------------------------------------------------------

fn parse_vk(vk_json: &str) -> Result<VerifyingKey<Bn254>, String> {
    let v: Value = serde_json::from_str(vk_json).map_err(|e| format!("vk json: {e}"))?;

    let g1 = |val: &Value| -> Result<G1Affine, String> {
        Ok(G1Affine::new_unchecked(
            fq_from_value(&val[0])?,
            fq_from_value(&val[1])?,
        ))
    };
    // snarkjs vk json stores Fq2 as [c0, c1] (real, imaginary).
    let g2 = |val: &Value| -> Result<G2Affine, String> {
        Ok(G2Affine::new_unchecked(
            Fq2::new(fq_from_value(&val[0][0])?, fq_from_value(&val[0][1])?),
            Fq2::new(fq_from_value(&val[1][0])?, fq_from_value(&val[1][1])?),
        ))
    };

    let ic_arr = v["IC"].as_array().ok_or("vk: missing IC")?;
    let mut gamma_abc_g1 = Vec::with_capacity(ic_arr.len());
    for pt in ic_arr {
        gamma_abc_g1.push(g1(pt)?);
    }

    Ok(VerifyingKey {
        alpha_g1: g1(&v["vk_alpha_1"])?,
        beta_g2: g2(&v["vk_beta_2"])?,
        gamma_g2: g2(&v["vk_gamma_2"])?,
        delta_g2: g2(&v["vk_delta_2"])?,
        gamma_abc_g1,
    })
}

/// Verify a proof JSON (as produced by `prove_inner`) against a snarkjs-format
/// verification key JSON (the Stage 7 verification_key.json). Returns true if
/// the proof is valid for its public signals.
pub fn verify_inner(vk_json: &str, result_json: &str) -> Result<bool, String> {
    let vk = parse_vk(vk_json)?;
    let res: Value = serde_json::from_str(result_json).map_err(|e| format!("result json: {e}"))?;

    let p = &res["proof"];
    let proof = Proof::<Bn254> {
        a: G1Affine::new_unchecked(fq_from_value(&p["a"][0])?, fq_from_value(&p["a"][1])?),
        b: G2Affine::new_unchecked(
            Fq2::new(fq_from_value(&p["b"][0][0])?, fq_from_value(&p["b"][0][1])?),
            Fq2::new(fq_from_value(&p["b"][1][0])?, fq_from_value(&p["b"][1][1])?),
        ),
        c: G1Affine::new_unchecked(fq_from_value(&p["c"][0])?, fq_from_value(&p["c"][1])?),
    };

    let pubs: Vec<Fr> = res["publicSignals"]
        .as_array()
        .ok_or("result: missing publicSignals")?
        .iter()
        .map(|v| {
            let s = v.as_str().ok_or("public signal must be a string")?;
            fr_from_dec(s)
        })
        .collect::<Result<_, _>>()?;

    let pvk = Groth16::<Bn254, CircomReduction>::process_vk(&vk).map_err(|e| format!("vk: {e}"))?;
    Groth16::<Bn254, CircomReduction>::verify_with_processed_vk(&pvk, &pubs, &proof)
        .map_err(|e| format!("verify: {e}"))
}

// ---- WASM bindings (browser-callable) -------------------------------------

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// Generate a proof in the browser. `zkey` is the proving key bytes,
    /// `witness_json` the witness array (from circom's witness calculator).
    #[wasm_bindgen]
    pub fn prove(zkey: &[u8], witness_json: &str) -> Result<String, JsValue> {
        prove_inner(zkey, witness_json).map_err(|e| JsValue::from_str(&e))
    }

    /// Verify a proof against a snarkjs-format verification key.
    #[wasm_bindgen]
    pub fn verify(vk_json: &str, result_json: &str) -> Result<bool, JsValue> {
        verify_inner(vk_json, result_json).map_err(|e| JsValue::from_str(&e))
    }
}

// ---- native test: validates the core crypto path --------------------------

#[cfg(test)]
mod test {
    use super::*;
    use std::path::PathBuf;

    fn circuit_build() -> PathBuf {
        // <iwa-prover>/../iwa-circuit/build
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("iwa-circuit")
            .join("build")
    }

    #[test]
    fn good_member_proof_verifies_and_tamper_fails() {
        let build = circuit_build();
        let zkey = std::fs::read(build.join("rep_final.zkey")).expect("rep_final.zkey");
        let vk_json =
            std::fs::read_to_string(build.join("verification_key.json")).expect("verification_key.json");
        let witness_json =
            std::fs::read_to_string(build.join("witness_pass.json")).expect("witness_pass.json");

        // Generate the proof from the good member's witness.
        let result = prove_inner(&zkey, &witness_json).expect("prove");

        // The SAME Stage 7 verification key accepts it.
        assert!(verify_inner(&vk_json, &result).expect("verify"), "good proof must verify true");

        // Tamper the public claim (bump threshold) -> verification must fail.
        let mut v: Value = serde_json::from_str(&result).unwrap();
        v["publicSignals"][1] = Value::String("5".to_string());
        let tampered = v.to_string();
        assert!(
            !verify_inner(&vk_json, &tampered).expect("verify tampered"),
            "tampered claim must verify false"
        );
    }
}
