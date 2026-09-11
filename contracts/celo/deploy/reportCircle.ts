// deploy/reportCircle.ts — read-only report of an already-deployed
// IwaCircleCelo. Sends nothing; only calls view functions.
//
// Run:
//   CIRCLE_ADDRESS=0x... npx hardhat run deploy/reportCircle.ts --network celo

import { ethers } from "hardhat";

export async function reportCircle(address: string): Promise<void> {
  const circle = await ethers.getContractAt("IwaCircleCelo", address);
  const memberCount = await circle.memberCount();
  const members: string[] = [];
  for (let i = 0; i < Number(memberCount); i++) {
    members.push(await circle.memberAt(i));
  }
  console.log(`Contract address:      ${address}`);
  console.log(`organizer():           ${await circle.organizer()}`);
  console.log(`token():               ${await circle.token()}`);
  console.log(`memberCount():         ${memberCount.toString()}`);
  members.forEach((m, i) => console.log(`memberAt(${i}):          ${m}`));
  console.log(`contributionAmount(): ${(await circle.contributionAmount()).toString()}`);
  console.log(`cadenceSeconds():      ${(await circle.cadenceSeconds()).toString()}`);
  console.log(`gracePeriodSeconds():  ${(await circle.gracePeriodSeconds()).toString()}`);
}

async function main(): Promise<void> {
  const address = process.env.CIRCLE_ADDRESS;
  if (address === undefined || address.length === 0) {
    throw new Error("Missing required environment variable CIRCLE_ADDRESS.");
  }
  await reportCircle(address);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
