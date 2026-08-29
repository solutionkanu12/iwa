use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

#[derive(Copy, Drop, Serde, PartialEq)]
pub enum IwaOperation {
    SettleContribution,
    SettleCure,
    SettlePayout,
    SettleRecovery,
}

#[derive(Copy, Drop, Serde, PartialEq)]
pub struct HelperConfig {
    pub iwa_circle: ContractAddress,
    pub privacy_pool: ContractAddress,
    pub usdc_token: ContractAddress,
    pub strk_token: ContractAddress,
}

#[starknet::interface]
pub trait IIwaStrk20Helper<TContractState> {
    fn get_config(self: @TContractState) -> HelperConfig;
    fn get_round_token_liability(
        self: @TContractState, circle_id: u32, round: u32, token: ContractAddress,
    ) -> u256;
    fn get_token_liability(self: @TContractState, token: ContractAddress) -> u256;
    fn privacy_invoke(
        ref self: TContractState,
        operation: IwaOperation,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        open_note_id: felt252,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod IwaStrk20Helper {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
    use crate::iwa_types::{ContributionStatus, PayoutStatus, SupportedAsset};
    use super::{HelperConfig, IIwaStrk20Helper, IwaOperation};

    const INVALID_CONFIG: felt252 = 'INVALID_CONFIG';
    const NOT_PRIVACY_POOL: felt252 = 'NOT_PRIVACY_POOL';
    const UNSUPPORTED_TOKEN: felt252 = 'UNSUPPORTED_TOKEN';
    const INVALID_INPUT_NOTE: felt252 = 'INVALID_INPUT_NOTE';
    const INVALID_OUTPUT_NOTE: felt252 = 'INVALID_OUTPUT_NOTE';
    const WRONG_MEMBER: felt252 = 'WRONG_MEMBER';
    const WRONG_STATE: felt252 = 'WRONG_STATE';
    const INBOUND_BALANCE_MISMATCH: felt252 = 'INBOUND_BALANCE';
    const INSUFFICIENT_LIABILITY: felt252 = 'INSUFFICIENT_LIABILITY';
    const BALANCE_BELOW_LIABILITY: felt252 = 'BALANCE_LT_LIABILITY';
    const STALE_POOL_ALLOWANCE: felt252 = 'STALE_POOL_ALLOWANCE';
    const APPROVAL_FAILED: felt252 = 'APPROVAL_FAILED';

    #[storage]
    struct Storage {
        iwa_circle: ContractAddress,
        privacy_pool: ContractAddress,
        usdc_token: ContractAddress,
        strk_token: ContractAddress,
        round_token_liability: Map<(u32, u32, ContractAddress), u256>,
        token_liability: Map<ContractAddress, u256>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        iwa_circle: ContractAddress,
        privacy_pool: ContractAddress,
        usdc_token: ContractAddress,
        strk_token: ContractAddress,
    ) {
        assert(!iwa_circle.is_zero(), INVALID_CONFIG);
        assert(!privacy_pool.is_zero(), INVALID_CONFIG);
        assert(!usdc_token.is_zero(), INVALID_CONFIG);
        assert(!strk_token.is_zero(), INVALID_CONFIG);
        assert(usdc_token != strk_token, INVALID_CONFIG);
        self.iwa_circle.write(iwa_circle);
        self.privacy_pool.write(privacy_pool);
        self.usdc_token.write(usdc_token);
        self.strk_token.write(strk_token);
    }

    #[abi(embed_v0)]
    impl IwaStrk20HelperImpl of IIwaStrk20Helper<ContractState> {
        fn get_config(self: @ContractState) -> HelperConfig {
            HelperConfig {
                iwa_circle: self.iwa_circle.read(),
                privacy_pool: self.privacy_pool.read(),
                usdc_token: self.usdc_token.read(),
                strk_token: self.strk_token.read(),
            }
        }

        fn get_round_token_liability(
            self: @ContractState, circle_id: u32, round: u32, token: ContractAddress,
        ) -> u256 {
            self.assert_supported_token(token);
            self.round_token_liability.read((circle_id, round, token))
        }

        fn get_token_liability(self: @ContractState, token: ContractAddress) -> u256 {
            self.assert_supported_token(token);
            self.token_liability.read(token)
        }

        fn privacy_invoke(
            ref self: ContractState,
            operation: IwaOperation,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            open_note_id: felt252,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.privacy_pool.read(), NOT_PRIVACY_POOL);
            self.assert_supported_token(token);
            self.assert_circle_token(circle_id, token);

            match operation {
                IwaOperation::SettleContribution => {
                    assert(open_note_id == 0, INVALID_INPUT_NOTE);
                    let core = self.core();
                    let obligation = core.get_contribution_obligation(circle_id, round, member_ref);
                    assert(obligation.status == ContributionStatus::Pending, WRONG_STATE);
                    let amount = obligation.required_amount;
                    self.assert_exact_inbound_balance(token, amount);
                    core
                        .settle_contribution_from_helper(
                            circle_id,
                            round,
                            member_ref,
                            token,
                            amount,
                            nonce,
                            signature_r,
                            signature_s,
                        );
                    self.credit_liability(circle_id, round, token, amount);
                    [].span()
                },
                IwaOperation::SettleCure => {
                    assert(open_note_id == 0, INVALID_INPUT_NOTE);
                    let core = self.core();
                    let cure = core.get_cure_state(circle_id, round, member_ref);
                    assert(!cure.deficit_settled && cure.window_open, WRONG_STATE);
                    let amount = cure.deficit_amount;
                    self.assert_exact_inbound_balance(token, amount);
                    core
                        .settle_cure_from_helper(
                            circle_id,
                            round,
                            member_ref,
                            token,
                            amount,
                            nonce,
                            signature_r,
                            signature_s,
                        );
                    self.credit_liability(circle_id, round, token, amount);
                    [].span()
                },
                IwaOperation::SettlePayout => {
                    assert(open_note_id != 0, INVALID_OUTPUT_NOTE);
                    let core = self.core();
                    let payout = core.get_payout_state(circle_id, round);
                    assert(payout.status == PayoutStatus::SettlementAuthorized, WRONG_STATE);
                    assert(member_ref == payout.scheduled_member_ref, WRONG_MEMBER);
                    let amount = payout.amount;
                    self.assert_outbound_available(circle_id, round, token, amount);
                    core
                        .settle_payout_from_helper(
                            circle_id, round, token, open_note_id, nonce, signature_r, signature_s,
                        );
                    self.debit_liability(circle_id, round, token, amount);
                    self.approve_pool(token, amount);
                    array![OpenNoteDeposit { note_id: open_note_id, token, amount }].span()
                },
                IwaOperation::SettleRecovery => {
                    assert(open_note_id != 0, INVALID_OUTPUT_NOTE);
                    let core = self.core();
                    let payout = core.get_payout_state(circle_id, round);
                    assert(payout.status == PayoutStatus::RecoveryPending, WRONG_STATE);
                    assert(member_ref == payout.scheduled_member_ref, WRONG_MEMBER);
                    let amount = core.get_recovery_amount(circle_id, round);
                    assert(amount != 0, WRONG_STATE);
                    self.assert_outbound_available(circle_id, round, token, amount);
                    core
                        .settle_recovery_from_helper(
                            circle_id, round, token, open_note_id, nonce, signature_r, signature_s,
                        );
                    self.debit_liability(circle_id, round, token, amount);
                    self.approve_pool(token, amount);
                    array![OpenNoteDeposit { note_id: open_note_id, token, amount }].span()
                },
            }
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn core(self: @ContractState) -> IIwaCircleDispatcher {
            IIwaCircleDispatcher { contract_address: self.iwa_circle.read() }
        }

        fn assert_supported_token(self: @ContractState, token: ContractAddress) {
            assert(
                !token.is_zero()
                    && (token == self.usdc_token.read() || token == self.strk_token.read()),
                UNSUPPORTED_TOKEN,
            );
        }

        fn assert_circle_token(self: @ContractState, circle_id: u32, token: ContractAddress) {
            let circle = self.core().get_circle(circle_id);
            let expected = match circle.asset {
                SupportedAsset::Usdc => self.usdc_token.read(),
                SupportedAsset::Strk => self.strk_token.read(),
            };
            assert(token == expected, UNSUPPORTED_TOKEN);
        }

        fn assert_exact_inbound_balance(
            self: @ContractState, token: ContractAddress, amount: u128,
        ) {
            assert(amount != 0, INBOUND_BALANCE_MISMATCH);
            let balance = IERC20Dispatcher { contract_address: token }
                .balance_of(account: get_contract_address());
            let expected = self.token_liability.read(token) + amount.into();
            assert(balance == expected, INBOUND_BALANCE_MISMATCH);
        }

        fn assert_outbound_available(
            self: @ContractState, circle_id: u32, round: u32, token: ContractAddress, amount: u128,
        ) {
            assert(amount != 0, INSUFFICIENT_LIABILITY);
            let amount_u256: u256 = amount.into();
            assert(
                self.round_token_liability.read((circle_id, round, token)) >= amount_u256,
                INSUFFICIENT_LIABILITY,
            );
            let total = self.token_liability.read(token);
            assert(total >= amount_u256, INSUFFICIENT_LIABILITY);
            let balance = IERC20Dispatcher { contract_address: token }
                .balance_of(account: get_contract_address());
            assert(balance >= total, BALANCE_BELOW_LIABILITY);
        }

        fn credit_liability(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            token: ContractAddress,
            amount: u128,
        ) {
            let amount_u256: u256 = amount.into();
            let key = (circle_id, round, token);
            self
                .round_token_liability
                .write(key, self.round_token_liability.read(key) + amount_u256);
            self.token_liability.write(token, self.token_liability.read(token) + amount_u256);
        }

        fn debit_liability(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            token: ContractAddress,
            amount: u128,
        ) {
            let amount_u256: u256 = amount.into();
            let key = (circle_id, round, token);
            self
                .round_token_liability
                .write(key, self.round_token_liability.read(key) - amount_u256);
            self.token_liability.write(token, self.token_liability.read(token) - amount_u256);
        }

        fn approve_pool(ref self: ContractState, token: ContractAddress, amount: u128) {
            let erc20 = IERC20Dispatcher { contract_address: token };
            let pool = self.privacy_pool.read();
            assert(
                erc20.allowance(owner: get_contract_address(), spender: pool) == 0,
                STALE_POOL_ALLOWANCE,
            );
            assert(erc20.approve(spender: pool, amount: amount.into()), APPROVAL_FAILED);
        }
    }
}
