import { ContractParameters, ExportedContract, loadRust } from '../vm/loader.js';
import {
    ABICoder,
    Address,
    BinaryReader,
    BinaryWriter,
    MethodMap,
    NetEvent,
    Selector,
    SelectorsMap,
} from '@btc-vision/bsi-binary';
import bitcoin from 'bitcoinjs-lib';
import { AddressGenerator, TapscriptVerificator } from '@btc-vision/transaction';
import { Logger } from '@btc-vision/logger';
import { BytecodeManager } from './GetBytecode.js';
import { Blockchain } from '../../blockchain/Blockchain.js';

export interface CallResponse {
    response?: Uint8Array;
    error?: Error;
    events: NetEvent[];
    callStack: Address[];
}

export class ContractRuntime extends Logger {
    #contract: ExportedContract | undefined;

    public readonly logColor: string = '#39b2f3';

    protected states: Map<bigint, bigint> = new Map();
    protected shouldPreserveState: boolean = false;

    protected events: NetEvent[] = [];

    protected readonly deployedContracts: Map<string, Buffer> = new Map();

    protected readonly abiCoder = new ABICoder();
    protected _bytecode: Buffer | undefined;

    private _viewAbi: SelectorsMap | undefined;
    private _writeMethods: MethodMap | undefined;

    private callStack: Address[] = [];

    private statesBackup: Map<bigint, bigint> = new Map();

    protected constructor(
        public readonly address: string,
        public readonly deployer: string,
        protected readonly gasLimit: bigint = 300_000_000_000n,
        private readonly potentialBytecode?: Buffer,
    ) {
        super();
    }

    public preserveState(): void {
        this.shouldPreserveState = true;
    }

    public getStates(): Map<bigint, bigint> {
        return this.states;
    }

    public get viewAbi(): SelectorsMap {
        if (!this._viewAbi) {
            throw new Error('View ABI not found');
        }

        return this._viewAbi;
    }

    public get writeMethods(): MethodMap {
        if (!this._writeMethods) {
            throw new Error('Write methods not found');
        }

        return this._writeMethods;
    }

    protected get bytecode(): Buffer {
        if (!this._bytecode) throw new Error(`Bytecode not found`);

        return this._bytecode;
    }

    public get contract(): any {
        if (!this.#contract) {
            throw new Error('Contract not initialized');
        }

        return this.#contract;
    }

    public async resetStates(): Promise<void> {
        this.states.clear();
    }

    public async getViewAbi(): Promise<void> {
        const abi = await this.contract.getViewABI();
        const reader = new BinaryReader(abi);

        this._viewAbi = reader.readViewSelectorsMap();

        return;
    }

    public async getWriteMethods(): Promise<void> {
        const abi = await this.contract.getWriteMethods();
        const reader = new BinaryReader(abi);

        this._writeMethods = reader.readMethodSelectorsMap();

        return;
    }

    public async setEnvironment(
        caller: Address = Blockchain.caller || this.deployer,
        callee: Address = Blockchain.callee || this.deployer,
        currentBlock: bigint = Blockchain.blockNumber,
        owner: Address = this.deployer,
        address: Address = this.address,
    ): Promise<void> {
        const writer = new BinaryWriter();
        writer.writeAddress(caller);
        writer.writeAddress(callee);
        writer.writeU256(currentBlock);
        writer.writeAddress(owner);
        writer.writeAddress(address);
        writer.writeU64(BigInt(Date.now()));

        await this.contract.setEnvironment(writer.getBuffer());
    }

    private generateAddress(
        salt: Buffer,
        from: Address,
    ): { contractAddress: Address; virtualAddress: Buffer } {
        const bytecode = BytecodeManager.getBytecode(from);
        const contractVirtualAddress = TapscriptVerificator.getContractSeed(
            bitcoin.crypto.hash256(Buffer.from(this.address, 'utf-8')),
            Buffer.from(bytecode),
            salt,
        );

        /** Generate contract segwit address */
        const contractSegwitAddress = AddressGenerator.generatePKSH(
            contractVirtualAddress,
            bitcoin.networks.regtest,
        );

        return { contractAddress: contractSegwitAddress, virtualAddress: contractVirtualAddress };
    }

    public async getEvents(): Promise<NetEvent[]> {
        const events = await this.contract.getEvents();
        const reader = new BinaryReader(events);

        return reader.readEvents();
    }

    public backupStates(): void {
        this.statesBackup = new Map(this.states);
    }

    public restoreStates(): void {
        this.states.clear();
        this.states = new Map(this.statesBackup);
    }

    protected async readMethod(
        selector: number,
        calldata: Buffer,
        caller?: Address,
        callee?: Address,
    ): Promise<CallResponse> {
        await this.loadContract();

        if (!!caller) {
            await this.setEnvironment(caller, callee);
        }

        const statesBackup = new Map(this.states);

        let error: Error | undefined;
        const response = await this.contract
            .readMethod(selector, calldata)
            .catch(async (e: unknown) => {
                this.contract.dispose();

                error = (await e) as Error;

                // Restore states
                this.states.clear();
                this.states = statesBackup;
            });

        const events = await this.getEvents();
        this.events = [...this.events, ...events];

        return {
            response,
            error,
            events: this.events,
            callStack: this.callStack,
        };
    }

    private hasModifiedStates(
        states: Map<bigint, bigint>,
        statesBackup: Map<bigint, bigint>,
    ): boolean {
        if (states.size !== statesBackup.size) {
            return true;
        }

        for (const [key, value] of states) {
            if (statesBackup.get(key) !== value) {
                return true;
            }
        }

        for (const [key, value] of statesBackup) {
            if (states.get(key) !== value) {
                return true;
            }
        }

        return false;
    }

    protected async readView(
        selector: number,
        caller?: Address,
        callee?: Address,
    ): Promise<CallResponse> {
        await this.loadContract();

        if (caller) {
            await this.setEnvironment(caller, callee);
        }

        const statesBackup = new Map(this.states);

        let error: Error | undefined;
        const response = await this.contract.readView(selector).catch(async (e: unknown) => {
            this.contract.dispose();

            error = (await e) as Error;

            // Restore states
            this.states.clear();
            this.states = statesBackup;
        });

        if (this.hasModifiedStates(this.states, statesBackup)) {
            throw new Error('OPNET: READONLY_MODIFIED_STATES');
        }

        const events = await this.getEvents();
        this.events = [...this.events, ...events];

        return {
            response,
            error,
            events: this.events,
            callStack: this.callStack,
        };
    }

    private async deployContractAtAddress(data: Buffer): Promise<Buffer | Uint8Array> {
        return new Promise(async (resolve, _reject) => {
            const reader = new BinaryReader(data);

            const address: Address = reader.readAddress();
            const salt: Buffer = Buffer.from(reader.readBytes(32)); //Buffer.from(`${reader.readU256().toString(16)}`, 'hex');
            const saltBig = BigInt(
                '0x' + salt.reduce((acc, byte) => acc + byte.toString(16).padStart(2, '0'), ''),
            );

            this.log(
                `This contract wants to deploy the same bytecode as ${address}. Salt: ${salt.toString('hex')} or ${saltBig}`,
            );

            const deployResult = this.generateAddress(salt, address);
            if (this.deployedContracts.has(deployResult.contractAddress)) {
                throw new Error('Contract already deployed');
            }

            if (address === this.address) {
                throw new Error('Cannot deploy the same contract');
            }

            const requestedContractBytecode = BytecodeManager.getBytecode(address) as Buffer;
            const newContract: ContractRuntime = new ContractRuntime(
                deployResult.contractAddress,
                this.address,
                this.gasLimit,
                requestedContractBytecode,
            );

            Blockchain.register(newContract);

            await newContract.init();

            this.log(`Deployed contract at ${deployResult.contractAddress.toString()}`);

            this.deployedContracts.set(deployResult.contractAddress, this.bytecode);

            const response = new BinaryWriter();
            response.writeBytes(deployResult.virtualAddress);
            response.writeAddress(deployResult.contractAddress);

            resolve(response.getBuffer());
        });
    }

    private async load(data: Buffer): Promise<Buffer | Uint8Array> {
        const reader = new BinaryReader(data);
        const pointer = reader.readU256();

        const value = this.states.get(pointer) || 0n;

        if (Blockchain.tracePointers) {
            this.log(`Attempting to load pointer ${pointer} - value ${value}`);
        }

        const response: BinaryWriter = new BinaryWriter();
        response.writeU256(value);

        return response.getBuffer();
    }

    private async store(data: Buffer): Promise<Buffer | Uint8Array> {
        const reader = new BinaryReader(data);
        const pointer: bigint = reader.readU256();
        const value: bigint = reader.readU256();

        if (Blockchain.tracePointers) {
            this.log(`Attempting to store pointer ${pointer} - value ${value}`);
        }

        this.states.set(pointer, value);

        const response: BinaryWriter = new BinaryWriter();
        response.writeU256(0n);

        return response.getBuffer();
    }

    private checkReentrancy(calls: Address[]): void {
        /*if (this.callStack.length !== new Set(this.callStack).size) {
            console.log(this.callStack);

            throw new Error(`OPNET: REENTRANCY DETECTED`);
        }*/

        if (calls.includes(this.address)) {
            throw new Error('OPNET: REENTRANCY DETECTED');
        }
    }

    public isReadonlyMethod(selector: Selector): boolean {
        for (const [_, value] of this.viewAbi) {
            if (value === selector) {
                return true;
            }
        }

        return false;
    }

    private canWrite(selector: Selector): boolean {
        for (const value of this.writeMethods) {
            if (value === selector) {
                return true;
            }
        }

        return false;
    }

    private async call(data: Buffer): Promise<Buffer | Uint8Array> {
        const reader = new BinaryReader(data);
        const contractAddress: Address = reader.readAddress();
        const calldata: Uint8Array = reader.readBytesWithLength();

        if (!contractAddress) {
            throw new Error(`No contract address specified in call?`);
        }

        if (Blockchain.traceCalls) {
            this.info(`Attempting to call contract ${contractAddress}`);
        }

        const contract: ContractRuntime = Blockchain.getContract(contractAddress);
        const callResponse = await contract.onCall(calldata, Blockchain.caller, this.address);

        this.events = [...this.events, ...callResponse.events];
        this.callStack = [...this.callStack, ...callResponse.callStack];

        this.checkReentrancy(callResponse.callStack);

        if (!callResponse.response) {
            throw new Error(`OPNET: CALL_FAILED: ${callResponse.error}`);
        }

        return callResponse.response;
    }

    public async onCall(
        data: Buffer | Uint8Array,
        caller: Address,
        callee: Address,
    ): Promise<CallResponse> {
        const reader = new BinaryReader(data);
        const selector: number = reader.readSelector();
        const calldata: Buffer = data.subarray(4) as Buffer;

        if (Blockchain.traceCalls) {
            this.log(
                `Called externally by an other contract. Selector: ${selector.toString(16)}`, //- Calldata: ${calldata.toString('hex')}
            );
        }

        await this.loadContract();

        let response: CallResponse;
        if (calldata.length === 0) {
            response = await this.readView(selector, caller, callee);
        } else {
            response = await this.readMethod(selector, calldata, caller, callee);
        }

        this.dispose();

        if (response.error) {
            throw response.error;
        }

        return {
            response: response.response,
            events: response.events,
            callStack: this.callStack,
        };
    }

    private onLog(data: Buffer | Uint8Array): void {
        const reader = new BinaryReader(data);
        const logData = reader.readStringWithLength();

        this.warn(`Contract log: ${logData}`);
    }

    private generateParams(): ContractParameters {
        return {
            bytecode: this.bytecode,
            gasLimit: this.gasLimit,
            gasCallback: this.onGas.bind(this),
            deployContractAtAddress: this.deployContractAtAddress.bind(this),
            load: this.load.bind(this),
            store: this.store.bind(this),
            call: this.call.bind(this),
            log: this.onLog.bind(this),
        };
    }

    public dispose(): void {
        if (this.#contract) {
            this.#contract.dispose();
        }
    }

    protected defineRequiredBytecodes(): void {
        if (this.potentialBytecode) {
            this._bytecode = this.potentialBytecode;

            BytecodeManager.setBytecode(this.address, this.potentialBytecode);
        } else {
            throw new Error('Not implemented');
        }
    }

    protected async loadContract(): Promise<void> {
        if (!this.shouldPreserveState) {
            this.states.clear();
        }

        this.events = [];
        this.callStack = [this.address];

        this.dispose();

        let params: ContractParameters = this.generateParams();
        this.#contract = await loadRust(params);

        await this.setEnvironment();

        if (!this._viewAbi) {
            await this.contract.defineSelectors();
            await this.getViewAbi();
            await this.getWriteMethods();
        }
    }

    private onGas(gas: bigint, method: string): void {
        if (Blockchain.traceGas) {
            this.debug('Gas:', gas, method);
        }
    }

    public async init(): Promise<void> {
        this.defineRequiredBytecodes();

        this._bytecode = BytecodeManager.getBytecode(this.address) as Buffer;

        await this.loadContract();
    }
}
