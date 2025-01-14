import { Address } from '@btc-vision/transaction';
import { MotoswapRouter } from '../../contracts/motoswap/MotoswapRouter.js';
import { AddLiquidityParameters } from '../../interfaces/RouterInterfaces.js';
import { MotoswapFactory } from '../../contracts/motoswap/MotoswapFactory.js';
import { MotoswapPool } from '../../contracts/motoswap/MotoswapPool.js';
import { getReserves } from '../../common/UtilFunctions.js';
import { Assert, Blockchain, OP_20, opnet, OPNetUnit } from '@btc-vision/unit-test-framework';
import { WBTC_ADDRESS } from '../../common.js';

const dttAddress: Address = Blockchain.generateRandomAddress();
const receiver: Address = Blockchain.generateRandomAddress();
const MINIMUM_LIQUIDITY = 1000n;

Blockchain.msgSender = receiver;
Blockchain.txOrigin = receiver;

let factory: MotoswapFactory;
let pool: MotoswapPool;
let DTT: OP_20;
let wbtc: OP_20;
let router: MotoswapRouter;

async function mintTokens(amountA: number = 11000000, amountB: number = 11000000) {
    await DTT.resetStates();
    await wbtc.resetStates();

    // Mint some token
    await DTT.mint(receiver, amountA);
    await wbtc.mint(receiver, amountB);

    const currentBalanceTokenA = await DTT.balanceOfNoDecimals(receiver);
    Assert.expect(currentBalanceTokenA).toEqual(amountA);

    const currentBalanceTokenB = await wbtc.balanceOfNoDecimals(receiver);
    Assert.expect(currentBalanceTokenB).toEqual(amountB);
}

function dispose() {
    Blockchain.dispose();
    Blockchain.clearContracts();

    if (factory) {
        factory.dispose();
    }

    if (pool) {
        pool.dispose();
    }

    if (DTT) {
        DTT.dispose();
    }

    if (wbtc) {
        wbtc.dispose();
    }

    if (router) {
        router.dispose();
    }
}

async function approveTokens(wbtcAmount: bigint, dttAmount: bigint): Promise<void> {
    await mintTokens();

    await DTT.approve(receiver, router.address, dttAmount);
    await wbtc.approve(receiver, router.address, wbtcAmount);
}

async function addLiquidity(DTTAmount: bigint, WBTCAmount: bigint) {
    await approveTokens(DTTAmount, WBTCAmount);

    const addLiquidityParameters: AddLiquidityParameters = {
        tokenA: WBTC_ADDRESS,
        tokenB: dttAddress,
        amountADesired: DTTAmount,
        amountBDesired: WBTCAmount,
        amountAMin: DTTAmount,
        amountBMin: WBTCAmount,
        to: receiver,
        deadline: 2n,
    };

    await router.addLiquidity(addLiquidityParameters);
}

await opnet('Motoswap Router', async (vm: OPNetUnit) => {
    vm.beforeEach(async () => {
        Blockchain.dispose();

        /** Init factory */
        factory = new MotoswapFactory(Blockchain.txOrigin);
        Blockchain.register(factory);

        /** Init template pool */
        pool = new MotoswapPool(dttAddress, WBTC_ADDRESS);
        Blockchain.register(pool);

        /** Init OP_20 */
        DTT = new OP_20({
            file: 'rust',
            deployer: Blockchain.txOrigin,
            address: dttAddress,
            decimals: 18,
        });

        wbtc = new OP_20({
            file: 'rust',
            deployer: Blockchain.txOrigin,
            address: WBTC_ADDRESS,
            decimals: 18,
        });

        Blockchain.register(DTT);
        Blockchain.register(wbtc);

        // Declare all the request contracts
        router = new MotoswapRouter(Blockchain.txOrigin);
        Blockchain.register(router);

        await Blockchain.init();
    });

    vm.afterEach(async () => {
        const wbtcBalanceOfRouter = await wbtc.balanceOf(router.address);
        dispose();

        Assert.expect(wbtcBalanceOfRouter).toEqual(0n);
    });

    vm.afterAll(() => {
        dispose();
    });

    /** TESTS */
    await vm.it(
        `verify that the factory address is valid and the WBTC address is valid`,
        async () => {
            const factoryAddress = await router.getFactory();

            Assert.expect(factoryAddress).toEqualAddress(factory.address);
        },
    );

    await vm.it(`addLiquidity`, async () => {
        const token0Amount: bigint = Blockchain.expandTo18Decimals(1);
        const token1Amount: bigint = Blockchain.expandTo18Decimals(4);
        const expectedLiquidity: bigint = Blockchain.expandTo18Decimals(2);

        await approveTokens(token0Amount, token1Amount);

        const addLiquidityParameters: AddLiquidityParameters = {
            tokenA: WBTC_ADDRESS,
            tokenB: dttAddress,
            amountADesired: token0Amount,
            amountBDesired: token1Amount,
            amountAMin: 0n,
            amountBMin: 0n,
            to: receiver,
            deadline: 100n,
        };

        const addLiquidity = await router.addLiquidity(addLiquidityParameters);

        const poolCreationEvent = addLiquidity.events[0];
        const transferEventA = addLiquidity.events[1];
        const transferEventB = addLiquidity.events[2];
        const mintEvent = addLiquidity.events[3];
        const mintBEvent = addLiquidity.events[4];
        const syncEvent = addLiquidity.events[5];
        const poolMintEvent = addLiquidity.events[6];

        if (
            !poolCreationEvent ||
            !transferEventA ||
            !transferEventB ||
            !mintEvent ||
            !mintBEvent ||
            !syncEvent ||
            !poolMintEvent
        ) {
            throw new Error('Invalid events');
        }

        Assert.expect(poolCreationEvent.type).toEqual('PoolCreated');
        Assert.expect(transferEventA.type).toEqual('Transfer');
        Assert.expect(transferEventB.type).toEqual('Transfer');
        Assert.expect(mintEvent.type).toEqual('Mint');
        Assert.expect(mintBEvent.type).toEqual('Mint');
        Assert.expect(syncEvent.type).toEqual('Sync');
        Assert.expect(poolMintEvent.type).toEqual('PoolMint');

        // Decode first transfer event
        const poolCreatedEvent = MotoswapPool.decodeTransferEvent(transferEventA.data);
        Assert.expect(poolCreatedEvent.from).toEqualAddress(receiver);
        Assert.expect(poolCreatedEvent.value).toEqual(token0Amount);

        // Decode second transfer event
        const poolCreatedEventB = MotoswapPool.decodeTransferEvent(transferEventB.data);
        Assert.expect(poolCreatedEventB.from).toEqualAddress(receiver);
        Assert.expect(poolCreatedEventB.value).toEqual(token1Amount);

        // Decode mint event
        const mintedEvent = MotoswapPool.decodeMintEvent(mintEvent.data);
        Assert.expect(mintedEvent.to).toEqualAddress(Blockchain.DEAD_ADDRESS);
        Assert.expect(mintedEvent.value).toEqual(MINIMUM_LIQUIDITY);

        // Decode mint event
        const mintedEventB = MotoswapPool.decodeMintEvent(mintBEvent.data);
        Assert.expect(mintedEventB.to).toEqualAddress(receiver);
        Assert.expect(mintedEventB.value).toEqual(expectedLiquidity - MINIMUM_LIQUIDITY);

        const pair: MotoswapPool = MotoswapPool.createFromRuntime(
            Blockchain.getContract(poolCreatedEvent.to),
            WBTC_ADDRESS,
            dttAddress,
        );
        await pair.init();

        // Decode sync event
        const syncEventDecoded = MotoswapPool.decodeSyncEvent(syncEvent.data);
        const sortedReserves = getReserves(WBTC_ADDRESS, dttAddress, token0Amount, token1Amount);

        Assert.expect(syncEventDecoded.reserve0).toEqual(sortedReserves.reserve0);
        Assert.expect(syncEventDecoded.reserve1).toEqual(sortedReserves.reserve1);

        // Decode pool mint event
        const poolMintEventDecoded = MotoswapPool.decodePoolMintEvent(poolMintEvent.data);
        Assert.expect(poolMintEventDecoded.to).toEqualAddress(router.address);

        Assert.expect(poolMintEventDecoded.amount0).toEqual(sortedReserves.reserve0); // token0Amount
        Assert.expect(poolMintEventDecoded.amount1).toEqual(sortedReserves.reserve1);

        const balanceOfReceiver = await pair.balanceOf(receiver);
        Assert.expect(balanceOfReceiver).toEqual(expectedLiquidity - MINIMUM_LIQUIDITY);

        pair.dispose();
    });
});
