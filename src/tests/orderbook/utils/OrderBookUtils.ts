import {
    Blockchain,
    generateTransactionId,
    Transaction,
    TransactionInput,
    TransactionOutput,
} from '@btc-vision/unit-test-framework';
import { LiquidityReserved, OrderBook } from '../../../contracts/order-book/OrderBook.js';

export function generateEmptyTransaction(): Transaction {
    const txId = generateTransactionId();

    const inputs: TransactionInput[] = [];
    const outputs: TransactionOutput[] = [];

    return new Transaction(txId, inputs, outputs);
}

export function createFeeOutput(value: bigint): void {
    // Create a new transaction.
    const tx: Transaction = generateEmptyTransaction();
    tx.addOutput(value, OrderBook.feeRecipient);

    Blockchain.transaction = tx;
}

export function calculateExpectedAmountOut(
    satoshisIn: bigint,
    slippage: number,
    ticksLiquidity: Array<[priceLevel: bigint, availableLiquidity: bigint]>,
    tokenDecimals: number = 18,
    minimumSatForTickReservation: bigint = 10_000n,
    minimumLiquidityForTickReservation: bigint = 1_000_000n,
): bigint {
    const tokenInDecimals = BigInt(10) ** BigInt(tokenDecimals);

    let expectedAmountOut = 0n;
    let remainingSatoshis = satoshisIn;

    // Traverse the ticks in ascending order of price level
    for (const [priceLevel, availableLiquidity] of ticksLiquidity) {
        if (remainingSatoshis < minimumSatForTickReservation) {
            break;
        }

        if (availableLiquidity < minimumLiquidityForTickReservation) {
            continue;
        }

        const price = priceLevel;

        // Calculate the maximum amount of tokens that can be bought at this tick
        const maxAmountPossible = (remainingSatoshis * tokenInDecimals) / price;

        // Determine the actual amount to reserve based on available liquidity
        const amountToReserve =
            maxAmountPossible < availableLiquidity ? maxAmountPossible : availableLiquidity;

        if (amountToReserve === 0n) {
            continue;
        }

        // Calculate the satoshis used to reserve this amount
        const satoshisUsed = (amountToReserve * price) / tokenInDecimals;

        remainingSatoshis -= satoshisUsed;
        expectedAmountOut += amountToReserve;

        if (remainingSatoshis < minimumSatForTickReservation) {
            break;
        }
    }

    // Apply slippage adjustment
    expectedAmountOut = (expectedAmountOut * BigInt(10000 - slippage)) / 10000n;

    return expectedAmountOut;
}

export function updateReserves(
    levels: Array<[priceLevel: bigint, availableLiquidity: bigint]>,
    user1Events: unknown[],
): void {
    for (let i = 0; i < user1Events.length - 1; i++) {
        const event = user1Events[i] as LiquidityReserved;

        const index = levels.findIndex((level) => level[0] === event.level);
        levels[index][1] -= event.amount;
    }
}
