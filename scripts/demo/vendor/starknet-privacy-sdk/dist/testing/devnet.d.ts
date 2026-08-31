/**
 * Devnet testing utilities
 *
 * Provides a managed Starknet devnet instance with predeployed contracts
 * and accounts for integration testing.
 */
import { Account, RpcProvider, type GetTransactionReceiptResponse } from "starknet";
import type { CallAndProof, PrivateTransfersInterface } from "../interfaces.js";
import { type DiscoveryOptions } from "../internal/contract-discovery.js";
import type { PrivacyPoolContract } from "../internal/private-transfers.js";
export interface DevnetConfig {
    /** Number of predeployed user accounts (excludes admin). Default: 2 (alice, bob). */
    userAccounts?: number;
}
export interface DevnetEnvironment {
    alice: Account;
    bob: Account;
    admin: Account;
    /** Extra user accounts beyond alice and bob (index 0 = 3rd user, etc.) */
    extraAccounts: Account[];
    strk: string;
    eth: string;
    privacy: PrivacyPoolContract;
    node: RpcProvider;
}
export declare class Devnet {
    private devnet?;
    private node?;
    setup?: DevnetEnvironment;
    private accountNonces;
    private config;
    private exitHandler?;
    constructor(config?: DevnetConfig);
    /** HTTP RPC URL of the running devnet (e.g. `http://127.0.0.1:5050`). */
    get url(): string;
    /** WebSocket URL of the running devnet (e.g. `ws://127.0.0.1:5050/ws`). */
    get wsUrl(): string;
    /**
     * Initialize the devnet environment and deploy all contracts
     */
    initialize(): Promise<DevnetEnvironment>;
    /**
     * Wrap an account with devnet-specific behavior:
     * - Automatic nonce management (local increment instead of network fetch)
     * - Fixed max_fee and tip for faster transaction submission
     */
    private wrapAccount;
    /**
     * Deploy the privacy pool contract
     */
    private deployPrivacyContract;
    /**
     * Execute a call via outside execution using the admin account.
     * The admin creates the outside transaction and executes it.
     * This simulates a paymaster flow.
     */
    executeOutside(callAndProof: CallAndProof): Promise<GetTransactionReceiptResponse>;
    /**
     * Terminate the devnet process and wait for it to exit.
     * Sends SIGINT first; escalates to SIGKILL after {@link timeoutMs}.
     */
    cleanup(timeoutMs?: number): Promise<void>;
    private removeExitHandler;
}
/**
 * Test environment for Devnet - mirrors MockTestEnv structure.
 */
export interface DevnetTestEnv {
    devnet: Devnet;
    env: DevnetEnvironment;
    transfers: {
        alice: PrivateTransfersInterface;
        bob: PrivateTransfersInterface;
    };
}
/**
 * Configuration for createDevnetTestEnv.
 */
export interface DevnetTestEnvConfig {
    /** Devnet configuration (account count, etc.) */
    devnet?: DevnetConfig;
    /** Options for discovery (rate limiting, etc.) */
    discoveryOptions?: DiscoveryOptions;
}
/**
 * Create a complete test environment with initialized devnet, accounts, and transfers.
 * This is the recommended way for SDK consumers to set up integration tests.
 *
 * @param devnet - The Devnet instance (must be created by caller for cleanup control)
 * @param config - Optional configuration for the test environment
 * @returns DevnetTestEnv with devnet, env, and transfers
 */
export declare function createDevnetTestEnv(devnet: Devnet, config?: DevnetTestEnvConfig): Promise<DevnetTestEnv>;
/**
 * A transfers object for `env.alice` whose proving provider never produces a screening attestation,
 * so a deposit goes out with a trailing `Option::None`. The pool requires an attestation for every
 * deposit, so such a deposit is expected to revert; this is used to assert an un-attested deposit
 * cannot slip through. It shares alice's account and viewing key, so register/setup performed by
 * the screening transfers apply to it too.
 */
export declare function createUnattestedAliceTransfers(env: DevnetEnvironment): PrivateTransfersInterface;
//# sourceMappingURL=devnet.d.ts.map