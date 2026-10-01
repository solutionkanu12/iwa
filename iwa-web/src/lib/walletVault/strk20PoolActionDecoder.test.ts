import { CairoOption, CairoOptionVariant, CallData, CairoCustomEnum } from "starknet";
import { describe, expect, it } from "vitest";

import { PrivacyPoolABI } from "../../../../scripts/demo/vendor/starknet-privacy-sdk/dist/internal/abi.js";
import { decodePinnedStrk20ServerActions } from "./strk20PoolActionDecoder";

const decoder = new CallData(PrivacyPoolABI);

function invokeAction(contractAddress: bigint, calldata: readonly bigint[]) {
  return new CairoCustomEnum({
    WriteOnce: undefined,
    Append: undefined,
    TransferFrom: undefined,
    TransferTo: undefined,
    EmitViewingKeySet: undefined,
    EmitWithdrawal: undefined,
    EmitDeposit: undefined,
    EmitOpenNoteCreated: undefined,
    EmitEncNoteCreated: undefined,
    EmitNoteUsed: undefined,
    Invoke: { contract_address: contractAddress, calldata: [...calldata] },
    InvokeWithComputation: undefined,
  });
}

describe("pinned STRK20 server-action decoder", () => {
  it("decodes the pinned SDK Invoke server action from canonical ABI bytes", () => {
    const applyActions = decoder.compile("apply_actions", [
      [invokeAction(0x9876n, [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])],
      new CairoOption(CairoOptionVariant.None),
    ]);
    // `screening` is a separately encoded Option appended after the exact
    // authenticated `Span<ServerAction>` carried in proof.output.
    const encoded = applyActions.slice(0, -1).map((felt) => `0x${BigInt(felt).toString(16)}`);

    expect(decodePinnedStrk20ServerActions(encoded)).toEqual([
      {
        type: "Invoke",
        contractAddress: "0x9876",
        calldata: ["0x0", "0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7", "0x8"],
      },
    ]);
  });
});
