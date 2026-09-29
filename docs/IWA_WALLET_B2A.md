# Iwa Wallet B2-A: Starknet authority and isolated deployment proof

## Scope

B2-A adds the first real chain authority to the encrypted Iwa Wallet vault.
It does not add STRK20 viewing material, Iwa settlement material, EVM, Solana,
mainnet interaction, a production relayer, or a production account-class
choice.

## Local authority model

`starknetAuthority.ts` creates a 32-byte Stark private scalar using Web Crypto
CSPRNG with rejection sampling against the Stark curve order. It does not
derive the scalar from the Iwa account, email, password, PIN, recovery code,
or passkey credential. The scalar has an exact `starknet/account` authority
namespace and is immediately re-encrypted into the existing vault root
manifest.

The encrypted descriptor has only these related public facts:

```text
networkId
accountClassId
accountClassHash
publicKey
accountAddress
descriptorVersion
deploymentState
```

The address is calculated locally from the verified class hash, public-key
constructor calldata, and public-key address salt. A descriptor can move from
`addressComputed` to `deployed` only after the vault deployment operation
waits for a transaction and verifies the class hash at that exact calculated
address.

## Deployment boundary

`WalletVault.deployStarknetAccount` receives a caller-supplied test/devnet RPC
provider. It validates the provider chain ID against the encrypted descriptor,
constructs a Starknet.js `Account` locally using a temporary `Uint8Array`
signer copy, submits `deployAccount`, verifies the returned address and class
hash, rewraps the descriptor as `deployed`, then wipes its temporary signer
copy. Before submitting, it probes the calculated address: only the documented
Starknet RPC `CONTRACT_NOT_FOUND` response permits deployment. The expected
class already present is recorded as a resumed deployment, while a different
class or any other provider error fails closed. It returns only public address,
transaction hash, and resume status.

The account deployment payer or test faucet may fund the counterfactual
address, but never receives the user signer. There is no B2-A paymaster,
relayer, sponsorship service, or backend signing path.

## Account contract rule

There is deliberately no hardcoded production class hash. The isolated harness
reads the class hash from a devnet predeployed account at runtime and requires
that its ABI expose `get_public_key`, `is_valid_signature`, and
`__validate_deploy__`, plus exactly one `felt252 public_key` constructor,
before using that class for a newly generated account. The devnet class is
evidence for the test environment only. Selecting a production account
implementation and class hash remains a separately reviewed release decision.

## Recovery and idempotency

The encrypted authority record is included in the same authenticated manifest
and portable package as other vault records. A recovery package restores the
same scalar, public key, counterfactual address, deployment state, and logical
Iwa Wallet ID under a newly enrolled local wallet passkey, password, and PIN.
It rotates recovery generation as before. It must never create a replacement
Starknet authority after an interrupted deployment: an existing local record
is reused, and a mismatch fails closed.

## Isolated harness

`.github/workflows/iwa-starknet-wallet-b2a.yml` is manually dispatched only
from an explicit temporary branch. It uses the B0-proven upstream-pinned
Starknet Devnet `0.8.0-rc.3`, Node `20.20.2`, no Docker, no cache, no artifact,
no production credential, and no public network. Runtime test authority and
devnet funding state are neither printed nor retained. The harness starts a
fresh devnet, dynamically verifies its account class ABI, generates a vault
authority, funds the counterfactual test address through the isolated devnet
faucet, deploys the account, verifies valid and invalid signatures, destroys
the local vault, recovers it, and verifies that the restored signer controls
the same account.

Until a temporary branch containing the harness is explicitly pushed and the
manual run succeeds, this is prepared test infrastructure rather than a
completed devnet deployment claim.
