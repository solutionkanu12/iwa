import { VaultError, type WalletPasskeyMetadata } from "./vaultCrypto";

const PRF_BYTES = 32;

export interface WalletPasskeyBrowser {
  credentials: Pick<CredentialsContainer, "create" | "get">;
  clientCapabilities?: () => Promise<Record<string, boolean>>;
  randomValues(array: Uint8Array): Uint8Array;
}

interface PrfExtensionResult {
  enabled?: unknown;
  results?: {
    first?: unknown;
  };
}

function fail(): never {
  throw new VaultError("unavailable");
}

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) fail();
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    fail();
  }
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let different = 0;
  for (let index = 0; index < first.length; index += 1) different |= first[index]! ^ second[index]!;
  return different === 0;
}

function assertRpId(rpId: string): void {
  if (rpId.length === 0 || rpId.length > 253 || /\s/.test(rpId)) fail();
}

function publicKeyCredential(value: Credential | null): PublicKeyCredential {
  const candidate = value as Partial<PublicKeyCredential> | null;
  if (
    value === null ||
    value.type !== "public-key" ||
    !(candidate?.rawId instanceof ArrayBuffer) ||
    typeof candidate.getClientExtensionResults !== "function"
  ) {
    fail();
  }
  return candidate as PublicKeyCredential;
}

function prfResultBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  fail();
}

/** Authentication PRF output has `results`; `enabled` is registration-only. */
function assertionPrf(credential: PublicKeyCredential): Uint8Array {
  const extension = credential.getClientExtensionResults().prf as PrfExtensionResult | undefined;
  const result = prfResultBytes(extension?.results?.first);
  if (result.length !== PRF_BYTES) {
    result.fill(0);
    fail();
  }
  return result;
}

/** Registration returns whether PRF is usable for the newly created credential. */
function assertRegistrationPrfEnabled(credential: PublicKeyCredential): void {
  const extension = credential.getClientExtensionResults().prf as PrfExtensionResult | undefined;
  if (extension?.enabled !== true) fail();
}

function random(browser: WalletPasskeyBrowser): Uint8Array {
  return browser.randomValues(new Uint8Array(PRF_BYTES));
}

/**
 * Browser boundary for Iwa Wallet's dedicated WebAuthn credential. It is not
 * connected to Iwa Account identity and never sends assertions or PRF output
 * to a server.
 */
export class BrowserWalletPasskey {
  constructor(private readonly browser: WalletPasskeyBrowser) {}

  async enroll(rpId: string): Promise<WalletPasskeyMetadata> {
    assertRpId(rpId);
    const capabilities = await this.browser.clientCapabilities?.();
    // WebAuthn Level 3 prefixes extension capability keys with `extension:`.
    // An unknown capability is verified by the mandatory ceremony below.
    if (capabilities?.["extension:prf"] === false) fail();

    const challenge = random(this.browser);
    const userId = random(this.browser);
    const prfInput = random(this.browser);
    let enrolled = false;
    try {
      const created = publicKeyCredential(
        await this.browser.credentials.create({
          publicKey: {
            challenge: cryptoBytes(challenge),
            rp: { id: rpId, name: "Iwa Wallet" },
            user: { id: cryptoBytes(userId), name: "Iwa Wallet", displayName: "Iwa Wallet" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -8 },
            ],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            attestation: "none",
            extensions: { prf: { eval: { first: cryptoBytes(prfInput) } } },
          },
        }),
      );
      assertRegistrationPrfEnabled(created);
      const credentialId = bytesToBase64Url(new Uint8Array(created.rawId));
      const binding: WalletPasskeyMetadata = { credentialId, rpId, prfInput };
      const verifiedOutput = await this.assertPrf(binding);
      verifiedOutput.fill(0);
      enrolled = true;
      return binding;
    } finally {
      challenge.fill(0);
      userId.fill(0);
      if (!enrolled) prfInput.fill(0);
    }
  }

  async assertPrf(binding: WalletPasskeyMetadata): Promise<Uint8Array> {
    assertRpId(binding.rpId);
    if (binding.prfInput.length !== PRF_BYTES) fail();
    const expectedId = base64UrlToBytes(binding.credentialId);
    const challenge = random(this.browser);
    try {
      const assertion = publicKeyCredential(
        await this.browser.credentials.get({
          publicKey: {
            challenge: cryptoBytes(challenge),
            rpId: binding.rpId,
            allowCredentials: [{ type: "public-key", id: cryptoBytes(expectedId) }],
            userVerification: "required",
            extensions: { prf: { eval: { first: cryptoBytes(binding.prfInput) } } },
          },
        }),
      );
      const returnedId = new Uint8Array(assertion.rawId);
      if (!sameBytes(expectedId, returnedId)) fail();
      return assertionPrf(assertion);
    } finally {
      expectedId.fill(0);
      challenge.fill(0);
    }
  }
}

/** Creates the production browser adapter without a fallback path. */
export function currentBrowserWalletPasskey(): BrowserWalletPasskey {
  if (typeof navigator === "undefined" || navigator.credentials === undefined || typeof PublicKeyCredential === "undefined") {
    fail();
  }
  const constructorWithCapabilities = PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };
  return new BrowserWalletPasskey({
    credentials: navigator.credentials,
    clientCapabilities: constructorWithCapabilities.getClientCapabilities?.bind(PublicKeyCredential),
    randomValues: (array) => crypto.getRandomValues(array),
  });
}
