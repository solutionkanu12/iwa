# Iwa — Master Build PRD (full stack, for Claude Code)

**One line:** Iwa is a digital ajo (rotating savings circle) on Stellar that turns everyday contributions into a Portable Trust Credential, a private proof of reliability you can show to unlock loans and services without exposing your money, your circle, or your identity.

**Build context:** Stellar Hacks: Real-World ZK (DoraHacks, $10,000 XLM, deadline June 29 2026, 12:00 PM PST). Zero-knowledge proofs do the real work. Build and demo on Stellar testnet.

**Source of visual truth:** `iwa-prototype.html`. Open it, scroll every section, click every flow, rebuild it faithfully. When this document and the prototype disagree on look, copy, or motion, the prototype wins.

**Terminology rule:** never say "credit score." Approved terms: **Portable Trust Credential** (lead/brand term), Private Proof of Reliability, Private Financial Reputation, Verifiable Savings Reputation. Pick one lead term and use it consistently in headline copy (see section 0.1).

---

## 0. Architecture truth (read first)

This is a web3 app, not a web2 app. There is intentionally:
- **No backend server.** No Node/Express/Python service. The "backend" is (a) Soroban smart contracts on Stellar and (b) ZK proof generation that runs on the user's device.
- **No traditional database.** On-chain contract storage holds shared state; the user's device holds all secrets. No Postgres/Mongo, nothing to host.
- **No API key.** Stellar testnet RPC is public and free. No paid third-party API in the stack.
- **No Railway/Render.** Nothing to deploy there. Frontend is a static site (Vercel or Netlify). Contracts deploy to Stellar testnet.

What we DO have: a static React frontend, Soroban contracts, a Circom ZK circuit, and browser-side proof generation.

### 0.1 Terminology decision (resolve once)
The prototype currently shows "Private Proof of Reliability" on the proof card. The locked brand term is "Portable Trust Credential." Both are allowed. Recommended split: **Portable Trust Credential** is the noun for the thing you hold and carry; **Private Proof of Reliability** can describe what a single proof shows. Keep headline/marketing copy on one lead term. If unsure, default headline copy to Portable Trust Credential. Never "credit score."

---

## 1. Scope

Full stack, built in stages. The frontend is built first against a mocked contract layer, then the real Soroban contracts and Circom circuit drop in behind the exact seam in section 11, with no UI changes.

**In scope:** the landing page and every section; the app screens and three flows; all motion; the Soroban savings contract; the reputation logic; the Circom circuit; browser proof generation; the Soroban verifier; the mocked contract layer and `generateProof()` stub; image assets.

**Out of scope now:** mainnet, real lender accounts, multi-circle aggregation, fiat/mobile-money on-ramps, trusted-setup ceremony (disclosed as a known limitation). Leave clean seams.

---

## 2. The one moment to nail

Flow 3, the verified moment: the cowrie seal turns verified mint, a ring draws around it and a halo pulses, while the contract confirms the person is reliable and shows zero personal data. This is the whole pitch in five seconds and the hero of the product. Spend polish here. Everything else stays calm so this lands.

---

## 3. Users

People who save in circles (ajo) and are invisible to banks, mostly on a phone, West Africa first. The saver is the hero, never the lender. Build mobile-first.

---

## 4. Stack and architecture

**Frontend**
- Vite + React + TypeScript.
- Styling: CSS modules or Tailwind, but the tokens in section 7 are fixed. If Tailwind, encode tokens in config, do not hand-pick values.
- Wallet: Stellar Wallets Kit (mock connect now, return a fake address).
- Chain: Stellar SDK against testnet. All chain access goes through the mock layer first.
- Seam: `lib/iwaContract.ts` (every contract function) and `lib/zk.ts` (proof generation). The UI imports only from these two. When real contracts land, only these files change.

**Backend (on-chain + on-device, no server)**
- Soroban smart contracts in Rust: the savings contract and the verifier contract.
- ZK circuit in Circom; proofs are Groth16; proving via snarkjs compiled to WASM.
- Start by forking Nethermind's Stellar Private Payments (privacy pool: Circom circuits, Groth16, Soroban verifier, browser WASM proving, ASP allow/deny). Run it untouched first, then adapt.
- Tooling: Rust, Stellar CLI (this also covers Soroban; the Soroban CLI was merged into it), Node, Circom, snarkjs.

### 4.1 Curve decision
Preferred: **BN254.** Reasons: Circom defaults to BN254, and Stellar Protocol 25/26 added native BN254 host functions that make on-chain verification cheaper. Confirm against whatever the forked Nethermind repo actually uses at fork time and adapt to it rather than fighting it. Curve choice does not touch the frontend; the `verify_proof` seam is curve-agnostic.

---

## 5. Image assets

Provided as separate files, recolored into the palette with backgrounds removed. In the prototype they are embedded inline so it previews as one file; in the real build, load them as normal image files from `/assets`.

| File | What it is | Where it goes |
|---|---|---|
| `iwa-cowrie-basket.jpg` | Cowrie shells on a woven basket, lavender duotone | Full-bleed background, hero down through community card, opacity ~0.3 |
| `iwa-circle.png` | Ring of people, lavender duotone, transparent | Inside the community glass card |
| `iwa-circle-color.png` | Same ring, original colours | Spare, social/deck only |
| `iwa-handshake.png` | Two hands meeting, lavender halftone | Full-bleed background of FAQ section, behind the glass card |
| `iwa-coin-hands.png` | Two hands passing a coin, lavender duotone | Beside the how-it-works steps |
| `iwa-dancers.png` | People dancing, iris silhouette | Top of the footer |
| `iwa-circle-hands.png` | Circle of people holding hands, iris silhouette | Small mark above "See it in action" |

The cowrie seal mark is currently inline SVG. For production, replace with a polished cowrie asset (image-gen or a light 3D render) exported transparent, keeping the same float, cursor-tilt, and mint settle animation in CSS. Do not model 3D at runtime.

---

## 6. Hard design rules (do not break)

No gradient text. No emojis. No exclamation marks. No `scale-1.02` hover (buttons shrink to ~0.95 and deepen to near-black ink instead). No pure white (use Cloud `#FBFAFE`). No "launch your" hero copy. No three-column feature grids (a multi-column footer is fine). No em dashes or hyphenated breaks in display or body copy, write separate sentences. Never "credit score."

Frosted glass cards over imagery (nav, dock, FAQ card, community card) are intentional. The no-overlays rule means no dimming layers that mute an image, it does not forbid glass.

---

## 7. Design system

### Color tokens
- `--mist #F6F4FC` default background, never pure white
- `--cloud #FBFAFE` raised surfaces and cards
- `--ink #2A2140` primary text, always set explicitly, never inherit
- `--ink-black #1b1430` button hover fill
- `--mut #5b5478` secondary text
- `--lav #B6A6F2` signature colour and ambient orbs
- `--iris #6D4DF2` primary actions (`--iris-dk #5d3eea`)
- `--mint #4FD9C0` reserved only for good standing and proof confirmed (`--mint-dk #0F6E56` for mint text). Never on body text or ordinary buttons.
- `--brd #e7e3f6` hairline borders

### Type
- Display, headings, wordmark, big numbers: **Bricolage Grotesque** (700–800 hero/wordmark, 600 section headings).
- Body and UI: **Inter**.
- Data and numbers: **Space Mono** (cycles, on-time rate, addresses, tx ids).
- All three from Google Fonts. Sentence case everywhere. One display face only.

### Components
- **Islands:** floating, detached from edges by a margin, soft lavender-tinted shadow. Top nav and bottom dock are frosted glass (translucent cloud + backdrop blur). Nav is fixed and floats over content on scroll.
- **Buttons:** Iris fill, Cloud text. Hover shrinks to ~0.95 and deepens to `--ink-black`. Ghost variant transparent with hairline border, same hover.
- **Cowrie seal:** one mark, triple duty (logo, app icon, verified stamp).
- **Glass cards:** translucent cloud + backdrop blur, FAQ card and community card over their images.

### Quality floor
Responsive to mobile, visible keyboard focus (Iris outline), reduced-motion respected, every control says exactly what it does and keeps the same word through the flow (`Generate proof` then `Proof generated`).

---

## 8. Motion system

- **Page-load rise:** hero elements rise in with a short stagger.
- **Cowrie 3D:** slow continuous float on a short perspective, heavier grounded shadow, cursor-tilt on the hero (off on touch and reduced-motion).
- **Verified moment:** seal settles front, fill shifts to mint, a mint ring draws and a halo pulses, then proof card and buttons rise in staggered.
- **Scroll reveal (staggered):** cards start lower and invisible, fade and rise as they enter view, ~130ms apart within a group. Applies to how-it-works steps, phone frames, FAQ questions, footer columns. Use IntersectionObserver, reveal once per visit, per-item transition-delay by index within parent group.
- **Ambient:** soft blurred lavender orbs drift slowly in the background.
- **Reduced-motion:** every animation off, content shows immediately, colour changes instant.

---

## 9. Landing page, section by section

1. **Glass nav (fixed):** cowrie glyph + links left (How it works, Roadmap), wordmark centered, Log in + Iris CTA + grid-menu button right. Frosted, floats over content.
2. **Hero:** mono eyebrow, the cowrie seal (3D, cursor-tilt), headline "Your good name, proven and private" in dark ink, subhead, primary CTA "Enter the circle". Cowrie basket image full-bleed behind.
3. **Community:** glass card centered over the basket background, holding the ring illustration, "Rooted in a real circle", and community copy.
4. **How it works:** two-up. Steps 01 / 02 / 03 on one side, coin-hands illustration on the other. Staggered reveal.
5. **See it in action:** circle-hands mark, heading, three phone frames (placeholders, real screenshots dropped in later: Your circle, Generate proof, Verified). Staggered reveal.
6. **Questions (FAQ):** handshake image edge to edge, frosted glass card on top with heading and accordion. Rows toggle plus to x. Staggered reveal.
7. **Footer:** dancers silhouette on top, four link columns (product; resources with Docs/Guides/Litepaper/GitHub; built on with Stellar/Soroban/Zero-knowledge proofs; company with About/Privacy/Terms), X and GitHub icon links (placeholder hrefs), large faded "iwa" wordmark behind. Staggered reveal.
8. **Dock (fixed glass):** slim sticky bar, cowrie + name + descriptor left, mono "Stellar testnet" tag + Iris CTA right.

---

## 10. App screens and the three flows

App screens live in a centered mobile column on the Mist ground, so the product reads as a phone app.

**Flow 1, Join a circle:** connect gate ("Connect wallet" via Stellar Wallets Kit, mocked) then the circle screen: anonymous member slots, round 3 of 8, amount, pot, your streak, the privacy promise line, and "Contribute 50 USDC". "Collect the pot" appears only when it is your turn.

**Flow 2, Contribute and collect:** confirm screen, `pay_contribution`, success state with a mint check that pops in and "Recorded. On time, as always." Collect uses `collect_pot`, confirmed privately.

**Flow 3, Prove your good name (the star):** My standing shows your record (big number, on-time rate, defaults), noted private to you. Generate proof lets you pick a claim, runs `generateProof()` then `verify_proof()`, with progress "Building proof on this device" then "Checking on Stellar" then "Verified". The verified screen plays the seal moment and shows a proof card (Verified badge, the claim, Portable Trust Credential, proof id, Stellar tx). Actions: copy proof link, and "Open as a lender sees it". The lender view shows only the verified claim and "This is everything the lender can see. No amounts, no circle, no identity."

Empty states invite action, errors explain plainly, no apologies, no exclamation marks.

---

## 11. Mocked contract interface (build exactly these)

```ts
// lib/iwaContract.ts — replace bodies with real Soroban calls, keep signatures
connectWallet(): Promise<string>
create_circle(cfg): Promise<{ circleId: string }>
join_circle(circleId: string): Promise<{ ok: boolean; slot: number }>
get_circle(circleId?: string): Promise<Circle>
pay_contribution(circleId: string, round: number): Promise<{ ok: boolean; onTime: boolean; txHash: string }>
advance_round(circleId: string): Promise<{ ok: boolean }>
collect_pot(circleId: string): Promise<{ ok: boolean; amount: number; txHash: string }>
verify_proof(proof, publicSignals): Promise<{ verified: boolean; txHash: string; ledger: number }>
```
```ts
// lib/zk.ts — replace with snarkjs witness calc + groth16 prove (WASM)
generateProof(claim): Promise<{ proof: string; publicSignals: string[]; claim }>
// must resolve after a short delay so the proof animation can run now
```

---

## 12. Backend spec (Soroban contracts + ZK circuit)

The real implementation behind the section 11 seam. Return shapes must match section 11 so the frontend wires in unchanged.

### 12.1 Savings contract (Rust / Soroban)
Functions (build before any ZK):
- `create_circle(amount, frequency, size) -> circle_id`
- `join_circle(circle_id, member_commitment) -> { ok, slot }`
- `pay_contribution(circle_id, round, member_commitment) -> { ok, on_time, tx }`
- `advance_round(circle_id) -> { ok, new_round, collector }`
- `collect_pot(circle_id, member_commitment) -> { ok, amount, tx }`
- `get_circle(circle_id) -> Circle`
Make contribution history seed-able (we cannot live through real rounds before the deadline).

### 12.2 Reputation logic
Compute per member: `completed_cycles`, `on_time_count`, `default_count`. These are the circuit inputs.

### 12.3 Circom circuit
- Private inputs: member secret, payment history.
- Public: threshold met (e.g. completed ≥ N, defaults = 0). Make the threshold a public input set by the verifier; demo with a small N like 2.
- No personal data leaks.
- Fallback if the custom circuit fights us: drop to the simpler proof (you are a member, in good standing) reusing Nethermind's existing circuit shape almost unchanged. The demo still works.

### 12.4 Browser proof generation
`generateProof()` runs snarkjs (witness + Groth16 prove) in WASM, locally. Secrets never touch a server. This is the privacy promise.

### 12.5 Verifier contract (Rust / Soroban)
`verify_proof(proof, public_signals) -> { verified, tx, ledger }`. Largely from the fork. Input proof, output valid/invalid.

---

## 13. Data requirements

No server database. Entities:

**On-chain (Soroban contract storage)**
- `Circle`: id, amount, frequency, size, current_round, status.
- `Membership`: circle_id, member_commitment (private stand-in for identity), slot.
- `Contribution`: circle_id, round, member_commitment, on_time, timestamp.
- `MerkleRoot`: root of membership commitments (used by the proof).
- `NullifierSet`: spent nullifiers, stops double-claims.

**Derived (computed, not raw-stored)**
- `ReputationRecord` per member: completed_cycles, on_time_count, default_count.

**Client-side only (never on chain, never on a server)**
- Member secret, real identity, mapping from identity to commitments.

**Event retention:** Stellar RPC keeps events ~7 days. Fine for a fresh demo; a long-lived deployment would need an indexer (roadmap).

---

## 14. Master build plan (deadline June 29)

Plumbing first, ZK second, demo sacred. Frontend and backend run in parallel across the two chats; this is the combined order.

1. **Environment (this chat):** Rust (done), Node, Stellar CLI (covers Soroban), Circom, snarkjs. Work in Linux home, not `/mnt/c`. Deploy the sample Soroban contract to testnet first, never start with our own.
2. **Fork Nethermind, run untouched.** Understand pool contract, Groth16 verifier, Circom circuit, browser WASM proving, ASP. Settle the curve here (prefer BN254).
3. **One-page architecture:** Frontend → Savings Contract → Contribution Records → Proof Generator → Verifier Contract → Result.
4. **Frontend first (other chat):** tokens, fonts, cowrie component, island/button/glass primitives. Then the four judged screens (Circle, Contribute, My standing, Generate proof + Verified). Then the verifier/lender view. Then the landing page with assets and scroll reveal. Then wallet connect + mock layer wired through. Do not let landing polish steal time from the verified screen.
5. **Savings contract (this chat), no ZK:** create/join/pay/advance/collect, seed-able history.
6. **Reputation logic:** compute the three numbers.
7. **ZK circuit (Circom), timeboxed.** Threshold as public input, demo N=2. Fallback ready.
8. **Browser proof generation (WASM).**
9. **Verifier contract,** valid/invalid.
10. **Wire frontend to real contracts** by replacing `lib/iwaContract.ts` and `lib/zk.ts` bodies. No UI changes.
11. **Demo video "Meet Ada"** (2–3 min, verify moment centered).
12. **Submission:** public repo, honest README (why ZK is load-bearing, what is mock/seeded/roadmap), testnet contract address, video link. Submit on DoraHacks before June 29, 12:00 PM PST.
13. **Launch tweet + final checklist.**

---

## 15. Deployment

- **Frontend:** static build, deploy to **Vercel or Netlify** (free). No server, no env secrets beyond a public RPC URL.
- **Contracts:** deploy to **Stellar testnet** via the Stellar CLI. Record the contract addresses in the README.
- **Nothing on Railway/Render. No database. No API key.**

---

## 16. Definition of done

- Every flow and section in the prototype is reachable in the React app.
- The verified moment animates fully; on reduced-motion the colour still changes.
- Scroll reveal staggers per group and respects reduced-motion.
- All copy matches the prototype, dash-free, sentence case, no "credit score."
- All backend access goes through `lib/iwaContract.ts` and `lib/zk.ts`.
- Images load from files, not inline base64.
- Savings circle works end to end on testnet: join → contribute → advance → collect.
- A real proof of good standing is generated in the browser and verified by the Soroban contract (valid for a good member, invalid for a bad one), revealing no personal data.
- README honest and complete; testnet addresses and video link included.
- Mobile-first, keyboard focus visible, no hard-rule violations.
- Submitted on DoraHacks before the deadline.

---

## 17. Roadmap (state honestly, do not build)
Multi-circle reputation, lender and service integration, fiat and mobile-money on-ramps, selective disclosure via view keys, real on-chain (mainnet) deployment after an audit.
```
