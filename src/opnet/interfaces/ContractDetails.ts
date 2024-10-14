import { Address } from '@btc-vision/bsi-binary';

export interface ContractDetails {
    readonly address: Address;
    readonly deployer: Address;

    readonly gasLimit?: bigint;

    readonly deploymentCalldata?: Buffer;
    readonly bytecode?: Buffer;
}