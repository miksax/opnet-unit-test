import { Address } from '@btc-vision/transaction';
import { Blockchain } from '../blockchain/Blockchain.js';
import { RustContract } from '../contracts/rust.js';
import { Assert } from '../opnet/unit/Assert.js';
import { opnet, OPNetUnit } from '../opnet/unit/OPNetUnit.js';

const rndAddress = Blockchain.generateRandomAddress();
const receiver: Address = Blockchain.generateRandomAddress();

await opnet('Compare OP_20 gas usage', async (vm: OPNetUnit) => {
    Blockchain.msgSender = receiver;
    Blockchain.txOrigin = receiver; // "leftmost thing in the call chain"

    await vm.it('should instantiate an OP_20 token', async () => {
        console.log('HAF HAF1');
        await Assert.expect(async () => {
            const token = new RustContract({
                fileName: 'rust',
                deployer: Blockchain.txOrigin,
                address: rndAddress,
                decimals: 18,
            });

            console.log('HAF HAF2');

            await token.init();
            console.log('HAF HAF3');
            await token.deployContract();
            console.log('HAF HAF4');

            token.dispose();
            console.log('HAF HAF5');
        }).toNotThrow();
    });

    // Declare all the request contracts
    const token = new RustContract({
        fileName: 'rust',
        deployer: Blockchain.txOrigin,
        address: rndAddress,
        decimals: 18,
    });

    Blockchain.register(token);

    vm.beforeEach(async () => {
        await Blockchain.init();
    });

    vm.afterAll(() => {
        Blockchain.dispose();
    });

    async function mintTokens() {
        await token.resetStates();

        const amountA = 11000000;

        // Mint some token
        await token.mint(receiver, amountA);

        const currentBalanceTokenA = await token.balanceOfNoDecimals(receiver);
        Assert.expect(currentBalanceTokenA).toEqual(amountA);
    }

    await vm.beforeAll(async () => {
        await Blockchain.init();

        await mintTokens();
    });

    await vm.it('should get the gas of a transfer', async () => {
        const time = Date.now();
        const transfer = await token.transfer(receiver, rndAddress, 100n);
        const elapsed = Date.now() - time;
        const currentGasUsed = 673985327n;

        if (transfer.usedGas <= currentGasUsed) {
            const savedGas = currentGasUsed - transfer.usedGas;
            vm.success(
                `Gas used is less than or equal to the expected gas (${savedGas} gas saved) (${transfer.usedGas} <= ${currentGasUsed})`,
            );
        } else {
            vm.error(
                `Gas used is more than the expected gas (${transfer.usedGas} > ${currentGasUsed})`,
            );
        }

        vm.info(`Elapsed time: ${elapsed}ms`);

        Assert.equal(transfer.usedGas <= currentGasUsed, true);
    });
});