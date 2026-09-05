// features/prizeSavings/zama.ts — the single wrapper around the Zama SDK.
//
// Everything this feature does with encrypted values goes through here:
// building an encrypted input (deposit/withdraw/fund requests) and decrypting
// a user's own balance handle through the EIP-712 user-decryption flow.
//
// The SDK instance is created lazily and kept for the session. Handles and
// decrypted values are returned to the caller only - nothing is logged, and
// nothing leaves the browser except the EIP-712 authorization the visitor's
// own wallet signs.

import { createInstance, type FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { hexlify } from "ethers";
import { ZAMA_SEPOLIA, SEPOLIA_CHAIN } from "../../chains/ethereum/config";
import { eip1193Provider, signTypedDataV4 } from "../../chains/ethereum/wallet";

let instancePromise: Promise<FhevmInstance> | null = null;

async function instance(): Promise<FhevmInstance> {
  if (instancePromise === null) {
    const provider = eip1193Provider();
    if (provider === null) throw new Error("No Ethereum wallet found in this browser");
    instancePromise = createInstance({
      verifyingContractAddressDecryption: ZAMA_SEPOLIA.KMSVerifierAddress,
      verifyingContractAddressInputVerification: ZAMA_SEPOLIA.InputVerifierAddress,
      kmsContractAddress: ZAMA_SEPOLIA.KMSVerifierAddress,
      inputVerifierContractAddress: ZAMA_SEPOLIA.InputVerifierAddress,
      aclContractAddress: ZAMA_SEPOLIA.ACLAddress,
      gatewayChainId: ZAMA_SEPOLIA.gatewayChainId,
      relayerUrl: ZAMA_SEPOLIA.relayerUrl,
      network: provider,
      chainId: SEPOLIA_CHAIN.chainIdNumber,
    });
  }
  return instancePromise;
}

export interface EncryptedValue {
  handle: string;
  inputProof: string;
}

/**
 * Encrypts a uint64 for the given contract, bound to the given user
 * (EIP-712: the input only verifies for that contract and that signer).
 */
export async function encryptUint64(
  contractAddress: string,
  userAddress: string,
  value: bigint,
): Promise<EncryptedValue> {
  const sdk = await instance();
  const encrypted = await sdk
    .createEncryptedInput(contractAddress, userAddress)
    .add64(value)
    .encrypt();
  return {
    handle: hexlify(encrypted.handles[0]),
    inputProof: hexlify(encrypted.inputProof),
  };
}

/**
 * Decrypts a handle the caller is allowed on, through the EIP-712
 * user-decryption flow: the wallet signs a scoped authorization, the Zama
 * KMS threshold-decrypts and re-encrypts to an ephemeral key, and the
 * browser decrypts locally. Returns the plain bigint to the caller only.
 */
export async function userDecryptUint64(
  contractAddress: string,
  userAddress: string,
  handle: string,
): Promise<bigint> {
  const sdk = await instance();
  const { publicKey, privateKey } = sdk.generateKeypair();

  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip712 = sdk.createEIP712(publicKey, [contractAddress], startTimestamp, durationDays);

  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signature = await signTypedDataV4(provider, userAddress, eip712);

  const results = await sdk.userDecrypt(
    [{ handle, contractAddress }],
    privateKey,
    publicKey,
    signature,
    [contractAddress],
    userAddress,
    startTimestamp,
    durationDays,
  );

  const value = results[handle as `0x${string}`];
  if (value === undefined) throw new Error("Decryption returned no value");
  return BigInt(value);
}