// Test runner settings for the coordination service.
//
// This file exists for one reason: the default five-second test timeout is too
// tight for this suite, and it produced a failure that looked for a long time
// like an environment problem.
//
// WHAT WAS ACTUALLY HAPPENING
//
// The suite is CPU-bound. Two hundred-odd tests drive a real HTTP stack and do
// real Starknet crypto — keccak over typed data, message hashes, signature
// verification against a stub — and they run in parallel worker threads. A full
// run spends sixty to ninety seconds of CPU inside a thirty-second wall clock,
// so the machine is saturated for the whole of it.
//
// Under that load, a test that normally finishes in milliseconds can wait a
// long time for a thread. Sixteen captured failures showed exactly this: all
// but one were `Test timed out in 5000ms`, they landed on a different test each
// run, and the worst reached 7793 ms. The clinching detail is that one of them,
// `binds the nonce, the chain and the account together`, is a SYNCHRONOUS test.
// A synchronous test cannot take five seconds to run. It can only be starved of
// the thread it needs, which means the number being exceeded was measuring
// contention rather than anything the code did.
//
// Failure tracked total duration precisely: runs that passed finished in 28.7
// to 28.9 seconds, the run that failed took 41.5.
//
// WHY THIS NUMBER
//
// Fifteen seconds is a little under twice the worst stall actually observed. It
// is chosen to be the smallest value with real headroom over measured
// contention, and deliberately not larger: a test that genuinely hangs should
// still fail a run in fifteen seconds rather than sit there. If a test ever
// approaches this, that is a signal worth reading, not a number to raise.
//
// Nothing else is configured. Concurrency and worker count are left at their
// defaults, because the timeout is the thing that was wrong; serialising the
// suite would hide the contention rather than tolerate it, and would make every
// run slower for everybody.
//
// Hook timeouts are left alone too. Every hook here is a synchronous beforeEach
// that builds an in-memory store and an Express app, no hook failure was ever
// observed, and vitest already allows hooks twice what it allowed tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
