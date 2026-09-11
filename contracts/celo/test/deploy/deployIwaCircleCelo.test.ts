import { expect } from "chai";
import { prepareDeployment } from "../../deploy/deployIwaCircleCelo";

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// Run under the default Hardhat network (chainId 31337), never 42220 — which
// is exactly what lets these tests prove the env-var and chainId guards fire
// without needing a live Celo connection or a real deployer key.
describe("prepareDeployment", function () {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(function () {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails clearly when CELO_RPC_URL is missing", async function () {
    delete process.env.CELO_RPC_URL;
    process.env.CELO_DEPLOYER_PRIVATE_KEY = "0x" + "1".repeat(64);
    const message = await rejectionMessage(prepareDeployment());
    expect(message).to.include("CELO_RPC_URL");
  });

  it("fails clearly when CELO_DEPLOYER_PRIVATE_KEY is missing", async function () {
    process.env.CELO_RPC_URL = "https://forno.celo.org";
    delete process.env.CELO_DEPLOYER_PRIVATE_KEY;
    const message = await rejectionMessage(prepareDeployment());
    expect(message).to.include("CELO_DEPLOYER_PRIVATE_KEY");
  });

  it("refuses to proceed when the connected chain is not 42220", async function () {
    process.env.CELO_RPC_URL = "https://forno.celo.org";
    process.env.CELO_DEPLOYER_PRIVATE_KEY = "0x" + "1".repeat(64);
    // The Hardhat test network reports its own chainId (31337 by default),
    // never 42220, so this exercises the real guard without a live RPC call.
    const message = await rejectionMessage(prepareDeployment());
    expect(message).to.match(/expected 42220/);
  });
});
