// Short felt252 error codes for IwaCircle (Task 6). No panic helpers here —
// callers panic_with_felt252 these constants. Keep each string <= 31 bytes.

pub const CIRCLE_NOT_FOUND: felt252 = 'IWA: circle not found';
pub const INVALID_CONFIG: felt252 = 'IWA: invalid config';
pub const CIRCLE_FULL: felt252 = 'IWA: circle full';
pub const ALREADY_MEMBER: felt252 = 'IWA: already member';
pub const NOT_MEMBER: felt252 = 'IWA: not member';
pub const ALREADY_PAID: felt252 = 'IWA: already paid';
pub const WRONG_ROUND: felt252 = 'IWA: wrong round';
pub const ALREADY_COLLECTED: felt252 = 'IWA: already collected';
pub const UNSUPPORTED_ASSET: felt252 = 'IWA: unsupported asset';
pub const PAYOUT_LOCKED: felt252 = 'IWA: payout locked';
pub const ORDER_LOCKED: felt252 = 'IWA: order locked';
pub const PAUSED: felt252 = 'IWA: paused';
pub const UNAUTHORIZED: felt252 = 'IWA: unauthorized';
pub const JOIN_CLOSED: felt252 = 'IWA: join closed';
pub const HISTORY_IMMUTABLE: felt252 = 'IWA: history immutable';
pub const INVALID_AUTH_KEY: felt252 = 'IWA: invalid auth key';
pub const INVALID_SIGNATURE: felt252 = 'IWA: invalid signature';
pub const WRONG_AMOUNT: felt252 = 'IWA: wrong amount';
pub const NONCE_USED: felt252 = 'IWA: nonce used';
pub const ALREADY_SATISFIED: felt252 = 'IWA: already satisfied';
pub const OBLIGATION_NOT_FOUND: felt252 = 'IWA: obligation not found';
pub const CONTRIBUTION_WINDOW_CLOSED: felt252 = 'IWA: window closed';
