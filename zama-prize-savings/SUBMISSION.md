# Iwa Prize Savings — Submission package (Zama Season 4)

Everything a real person needs to finish the submission. Contracts and the
feature are verified; the remaining actions are human.

---

## 1. Demo video script (max 3 minutes, real person, no AI voice/presenter)

One continuous recording. Screen-record a browser at `/app/prize-savings`
with a wallet connected to Sepolia. Keep the tone calm and product-first.

| Time | Beat | What happens on screen |
|---|---|---|
| 0:00–0:20 | What Iwa is | "Iwa is private community savings. Groups save together, the way ajo and esusu always worked - and Iwa keeps the money private and the record trustworthy. This is one Iwa feature: Prize Savings." |
| 0:20–0:45 | The problem | "Public savings apps expose your balance and your financial behaviour to anyone who looks. Here, deposits, balances and even the winner stay encrypted - on chain, the whole time." |
| 0:45–1:15 | Connect, wrap | Connect the Ethereum wallet, land on Sepolia. Get the test token and wrap it into the confidential cMockUSD. "This one wrap is public - it's the only amount anyone ever sees. From here on, everything is encrypted." |
| 1:15–1:45 | Private deposit + decrypt | Deposit 40 confidentially. "No amount appeared on chain." Then reveal your own balance with a signature you approve: "That decryption happens on my device, for my eyes only. The pool knows my balance as a ciphertext; it can use it, it can't read it." |
| 1:45–2:15 | Lock + weighted draw | The host funds the round's reward, locks the round, runs the draw. "A weighted, encrypted draw over live balances - nobody's balance is decrypted to pick a winner. The winner is an encrypted index." |
| 2:15–2:40 | Claim + withdraw | Both participants claim - the transactions look identical. The winner's balance grows; then withdraw principal and reward confidentially. "Principal was never locked. Everyone gets their money back; the winner gets the reward on top." |
| 2:40–3:00 | Privacy in one line | "Balances and the winner stay encrypted with Zama's FHE. Iwa keeps the money private, and the maths is verifiable." |

Notes: do not call Iwa a lottery product. Prize Savings is one Iwa feature.
No AI-generated voice or presenter.

---

## 2. X launch thread (draft)

1. Savings groups have worked for centuries. The internet broke them: to use
   a savings app you hand over your balance and your history.
   Iwa is private community savings. And today Iwa Prize Savings ships.

2. Prize Savings is one Iwa feature: deposit into a shared pool, keep every
   unit of principal withdrawable, and earn a chance at a shared reward
   through a confidential draw.

3. Why privacy matters here: a balance is not just a number, it is a story
   about your life. No app should expose it by default.

4. On Iwa Prize Savings, deposits, balances, the reward and even the winner
   stay encrypted on chain - with FHE, via Zama. A deposit never appears in
   the clear. The winner is an encrypted index, not a name.

5. "Save privately. Keep your principal. Earn a chance at shared rewards."

6. Live now (Sepolia): https://useiwa.xyz/app/prize-savings
   Contracts: 0x2d1b97F7e1E4845260aBd23017686fBa38006037 on Ethereum Sepolia.
   Repo: [repo URL]

7. One honest note: this is a testnet deployment for the Zama developer
   program, with a known admission limitation documented in the repo - the
   path to mainnet is real work, and it is scoped.

8. Thanks @zama for the encryption that makes "private and verifiable"
   a single sentence.

(Keep the thread as written: simple, product-first, no hype spam, no
hackathon-first framing.)

---

## 3. Submission-form answers

- **Project name:** Iwa Prize Savings
- **Short description:** Private prize savings inside Iwa - confidential
  deposits, encrypted balances, and a verifiable confidential weighted draw,
  with principal always withdrawable.
- **What it does:** Savers deposit confidentially into a shared pool on
  Ethereum Sepolia, the host funds a reward, a weighted draw selects a winner
  under encryption, and everyone claims and withdraws without ever revealing
  an amount or a winner on chain.
- **How Zama is used:** fhEVM FHE via `@fhevm/solidity` 0.11.1 - encrypted
  uint64 balances, encrypted arithmetic for the weighted walk, encrypted
  winner selection, EIP-712 user decryption through the Zama KMS, and the
  relayer SDK for encrypted input construction.
- **Confidentiality design:** ERC-7984 confidential token (OpenZeppelin
  confidential-contracts 0.5.3) for deposits; a plaintext power-of-two pool
  cap enables bounded encrypted randomness; a cumulative encrypted walk over
  live balances picks the winner; claiming is a pull that credits an
  encrypted zero or an encrypted reward.
- **What stays encrypted:** deposit and withdrawal amounts, participant
  balances, the prize reserve, the draw ticket, the winner index, claim
  payouts.
- **What remains public:** membership, participant indices, timing, contract
  addresses, round state, and the one-time wrap amount (the underlying ERC-20
  transfer is public).
- **Live app URL:** https://useiwa.xyz/app/prize-savings
- **GitHub repo:** [repo URL placeholder]
- **Sepolia contract addresses:** MockUSD
  `0x0041A7b8Bb29cA5D6b1Cb6eFBcaBAc8519075392`, CMockUSD
  `0xB87CE72B9083488977372507efD4127e157510c2`, IwaPrizeSavings
  `0x2d1b97F7e1E4845260aBd23017686fBa38006037` (chainId 11155111)
- **Demo video URL:** [placeholder]
- **X thread URL:** [placeholder]
- **Technical challenges:** all-or-nothing ERC-7984 transfer semantics forced
  actual-returned-value accounting; encrypted totals cannot be branched on,
  so headroom clamping and winner selection are pure FHE; per-write ACL
  re-grants must survive across transactions; bounded HCU at 16 participants.
- **Known limitations:** 16 zero-transfer wallets can fill the participant
  cap (accepted for this testnet MVP only - blocks production/mainnet); the
  one-time wrap is public; the testnet token is an open-mint mock.
- **Why this matters:** private savings should not require surrendering a
  financial history. Iwa separates the money from the record, and Prize
  Savings shows the same principle on Ethereum with FHE.

---

## 4. Final release checklist

- [ ] Contract suite green: `cd zama-prize-savings && npm test` (159 tests)
- [ ] Frontend suite green: `cd iwa-web && npm test` (589 tests)
- [ ] Contract typecheck: `cd zama-prize-savings && npm run typecheck`
- [ ] Frontend build: `cd iwa-web && npm run build`
- [ ] Live route serves `/app/prize-savings` after deploy
- [ ] Sepolia contracts confirmed at the recorded addresses
- [ ] Mobile layout checked on the deployed route
- [ ] README + leakage analysis in place (this document + module README)
- [ ] No secrets: `git diff --cached` reviewed; `.env` git-ignored
- [ ] No unrelated files staged (PRD/install artifacts excluded)
- [ ] Correct Git author configured; no AI attribution in commits
- [ ] Demo video recorded (≤3 min, real person, no AI voice)
- [ ] X thread posted (tagging @zama, #ZamaDeveloperProgram)
- [ ] Repo made public
- [ ] Submission form completed with the answers above