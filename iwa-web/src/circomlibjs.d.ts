// Minimal ambient types for circomlibjs 0.1.7, which ships no declarations.
//
// We use only buildPoseidon. It resolves to a hash function that also carries
// the field F: poseidon(inputs) returns an internal field element, F.toObject
// turns it into a BigInt, and F.p is the field modulus (BN254 scalar field).
declare module "circomlibjs" {
  export interface PoseidonField {
    p: bigint;
    toObject(a: unknown): bigint;
  }
  export interface Poseidon {
    (inputs: Array<bigint | number | string>): unknown;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
