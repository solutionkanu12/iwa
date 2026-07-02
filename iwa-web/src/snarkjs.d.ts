// Minimal ambient types for snarkjs, which ships no declarations. We use only
// Groth16 proving in the browser: fullProve takes the witness input and the URLs
// of the circuit wasm and proving key, and returns the proof plus public signals
// as decimal strings.
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
