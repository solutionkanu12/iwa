#[starknet::interface]
pub trait ITestErc20<TContractState> {
    fn mint(ref self: TContractState, account: starknet::ContractAddress, amount: u256);
}

/// Test-only standard ERC-20 used to exercise real balance and allowance calls.
#[starknet::contract]
pub mod TestErc20 {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, name: ByteArray, symbol: ByteArray) {
        self.erc20.initializer(name, symbol);
    }

    #[abi(embed_v0)]
    impl TestMintImpl of super::ITestErc20<ContractState> {
        fn mint(ref self: ContractState, account: ContractAddress, amount: u256) {
            self.erc20.mint(account, amount);
        }
    }
}
