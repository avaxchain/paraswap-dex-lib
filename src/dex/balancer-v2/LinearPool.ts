import { Interface } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';
import { isSameAddress, decodeThrowError } from './utils';
import * as LinearMath from './LinearMath';
import { BZERO } from './balancer-v2-math';
import { BasePool } from './balancer-v2-pool';
import { callData, SubgraphPoolBase, PoolState, TokenState } from './types';
import LinearPoolABI from '../../abi/balancer-v2/linearPoolAbi.json';
import { SwapSide } from '../../constants';

export enum PairTypes {
  BptToMainToken,
  MainTokenToBpt,
  MainTokenToWrappedToken,
  WrappedTokenToMainToken,
  BptToWrappedToken,
  WrappedTokenToBpt,
}

type LinearPoolPairData = {
  tokens: string[];
  balances: bigint[];
  indexIn: number;
  indexOut: number;
  scalingFactors: bigint[];
  bptIndex: number;
  swapFee: bigint;
  amp: bigint;
  wrappedIndex: number;
  mainIndex: number;
  lowerTarget: bigint;
  upperTarget: bigint;
};

/*
Linear (Boosted) Pools are designed to facilitate trades between stablecoins while simultaneously forwarding much of the pool's 
liquidity to external protocols, such as Aave. 
One of the key features that makes trades through Boosted Pools so simple is the use of Phantom BPT. Normally when a Liquidity 
Provider joins/exits a pool, the pool mints/burns pool tokens as needed. This is gas intensive and requires users to execute a join or exit. 
In pools that use Phantom BPT, however, all pool tokens are minted at the time of pool creation and are held by the pool itself. 
With Phantom BPT, Liquidity Providers use a swap (or more likely a batchSwap) to trade to or from a pool token to join or exit, respectively. 
*/
export class LinearPool extends BasePool {
  // This is the maximum token amount the Vault can hold. In regular operation, the total BPT supply remains constant
  // and equal to _INITIAL_BPT_SUPPLY, but most of it remains in the Pool, waiting to be exchanged for tokens. The
  // actual amount of BPT in circulation is the total supply minus the amount held by the Pool, and is known as the
  // 'virtual supply'.
  MAX_TOKEN_BALANCE = BigNumber.from('2').pow('112').sub('1');
  vaultAddress: string;
  vaultInterface: Interface;
  poolInterface: Interface;

  constructor(vaultAddress: string, vaultInterface: Interface) {
    super();
    this.vaultAddress = vaultAddress;
    this.vaultInterface = vaultInterface;
    this.poolInterface = new Interface(LinearPoolABI);
  }

  /*
    scaling factors should include rate:
    The wrapped token's scaling factor is not constant, but increases over time as the wrapped token increases in value.
    i.e. 
    scalingFactors: pool.tokens.map(({ decimals, priceRate }) =>
        MathSol.mulDownFixed(getTokenScalingFactor(decimals), priceRate)
    )
    */
  onSell(amounts: bigint[], poolPairData: LinearPoolPairData): bigint[] {
    return this._swapGivenIn(
      amounts,
      poolPairData.tokens,
      poolPairData.balances,
      poolPairData.indexIn,
      poolPairData.indexOut,
      poolPairData.bptIndex,
      poolPairData.wrappedIndex,
      poolPairData.mainIndex,
      poolPairData.scalingFactors,
      poolPairData.swapFee,
      poolPairData.lowerTarget,
      poolPairData.upperTarget,
    );
  }

  _swapGivenIn(
    tokenAmountsIn: bigint[],
    tokens: string[],
    balances: bigint[],
    indexIn: number,
    indexOut: number,
    bptIndex: number,
    wrappedIndex: number,
    mainIndex: number,
    scalingFactors: bigint[],
    swapFeePercentage: bigint,
    lowerTarget: bigint,
    upperTarget: bigint,
  ): bigint[] {
    /* 
        Linear pools allow trading between:
        wrappedToken <> mainToken
        wrappedToken <> BPT
        mainToken <> BPT
        */
    let pairType: PairTypes;
    if (isSameAddress(tokens[indexIn], tokens[bptIndex])) {
      if (isSameAddress(tokens[indexOut], tokens[wrappedIndex]))
        pairType = PairTypes.BptToWrappedToken;
      else pairType = PairTypes.BptToMainToken;
    } else if (isSameAddress(tokens[indexOut], tokens[bptIndex])) {
      if (isSameAddress(tokens[indexIn], tokens[wrappedIndex]))
        pairType = PairTypes.WrappedTokenToBpt;
      else pairType = PairTypes.MainTokenToBpt;
    } else {
      if (isSameAddress(tokens[indexIn], tokens[wrappedIndex]))
        pairType = PairTypes.WrappedTokenToMainToken;
      else pairType = PairTypes.MainTokenToWrappedToken;
    }

    const balancesUpscaled = this._upscaleArray(balances, scalingFactors);
    const tokenAmountsInScaled = tokenAmountsIn.map(a =>
      this._upscale(a, scalingFactors[indexIn]),
    );

    // VirtualBPTSupply must be used for the maths
    const virtualBptSupply = this.MAX_TOKEN_BALANCE.sub(
      balances[bptIndex],
    ).toBigInt();

    const amountsOut = this._onSwapGivenIn(
      tokenAmountsInScaled,
      balancesUpscaled[mainIndex],
      balancesUpscaled[wrappedIndex],
      swapFeePercentage,
      lowerTarget,
      upperTarget,
      virtualBptSupply,
      pairType,
    );

    // amountOut tokens are exiting the Pool, so we round down.
    return amountsOut.map(a =>
      this._downscaleDown(a, scalingFactors[indexOut]),
    );
  }

  /*
     Called when a swap with the Pool occurs, where the amount of tokens entering the Pool is known.
     All amounts are upscaled.
     Swap fee is NOT already deducted.
     The return value is also considered upscaled, and should be downscaled (rounding down)
     */
  _onSwapGivenIn(
    tokenAmountsIn: bigint[],
    mainBalance: bigint,
    wrappedBalance: bigint,
    fee: bigint,
    lowerTarget: bigint,
    upperTarget: bigint,
    virtualBptSupply: bigint,
    pairType: PairTypes,
  ): bigint[] {
    const amountsOut: bigint[] = [];

    switch (pairType) {
      case PairTypes.BptToMainToken:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcMainOutPerBptIn(
              amountIn,
              mainBalance,
              wrappedBalance,
              virtualBptSupply,
              {
                fee: fee,
                lowerTarget: lowerTarget,
                upperTarget: upperTarget,
              },
            );
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      case PairTypes.MainTokenToBpt:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcBptOutPerMainIn(
              amountIn,
              mainBalance,
              wrappedBalance,
              virtualBptSupply,
              {
                fee: fee,
                lowerTarget: lowerTarget,
                upperTarget: upperTarget,
              },
            );
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      case PairTypes.MainTokenToWrappedToken:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcWrappedOutPerMainIn(amountIn, mainBalance, {
              fee: fee,
              lowerTarget: lowerTarget,
              upperTarget: upperTarget,
            });
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      case PairTypes.WrappedTokenToMainToken:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcMainOutPerWrappedIn(amountIn, mainBalance, {
              fee: fee,
              lowerTarget: lowerTarget,
              upperTarget: upperTarget,
            });
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      case PairTypes.BptToWrappedToken:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcWrappedOutPerBptIn(
              amountIn,
              mainBalance,
              wrappedBalance,
              virtualBptSupply,
              {
                fee: fee,
                lowerTarget: lowerTarget,
                upperTarget: upperTarget,
              },
            );
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      case PairTypes.WrappedTokenToBpt:
        tokenAmountsIn.forEach(amountIn => {
          let amt: bigint;
          try {
            amt = LinearMath._calcBptOutPerWrappedIn(
              amountIn,
              mainBalance,
              wrappedBalance,
              virtualBptSupply,
              {
                fee: fee,
                lowerTarget: lowerTarget,
                upperTarget: upperTarget,
              },
            );
          } catch (err) {
            amt = BZERO;
          }
          amountsOut.push(amt);
        });
        break;
      default:
        amountsOut.push(BZERO);
    }
    return amountsOut;
  }

  /*
    Helper function to parse pool data into params for onSell function.
    */
  parsePoolPairData(
    pool: SubgraphPoolBase,
    poolState: PoolState,
    tokenIn: string,
    tokenOut: string,
  ): LinearPoolPairData {
    let indexIn = 0,
      indexOut = 0,
      bptIndex = 0;
    const balances: bigint[] = [];
    const scalingFactors: bigint[] = [];

    const tokens = pool.tokens.map((t, i) => {
      if (t.address.toLowerCase() === tokenIn.toLowerCase()) indexIn = i;
      if (t.address.toLowerCase() === tokenOut.toLowerCase()) indexOut = i;
      if (t.address.toLowerCase() === pool.address.toLowerCase()) bptIndex = i;

      balances.push(poolState.tokens[t.address.toLowerCase()].balance);
      scalingFactors.push(
        poolState.tokens[t.address.toLowerCase()].scalingFactor || BigInt(0),
      );
      return t.address;
    });
    const poolPairData: LinearPoolPairData = {
      tokens,
      balances,
      indexIn,
      indexOut,
      scalingFactors,
      bptIndex,
      swapFee: poolState.swapFee,
      amp: poolState.amp || BigInt(0),
      wrappedIndex: poolState.wrappedIndex || 0,
      mainIndex: poolState.mainIndex || 0,
      lowerTarget: poolState.lowerTarget || BigInt(0),
      upperTarget: poolState.upperTarget || BigInt(0),
    };
    return poolPairData;
  }

  /*
    Helper function to construct onchain multicall data for Linear Pool.
  */
  getOnChainCalls(pool: SubgraphPoolBase): callData[] {
    const poolCallData: callData[] = [
      {
        target: this.vaultAddress,
        callData: this.vaultInterface.encodeFunctionData('getPoolTokens', [
          pool.id,
        ]),
      },
      {
        target: pool.address,
        callData: this.poolInterface.encodeFunctionData('getSwapFeePercentage'),
      },
    ];
    poolCallData.push({
      target: pool.address,
      callData: this.poolInterface.encodeFunctionData('getScalingFactors'),
    });
    // returns lowerTarget, upperTarget
    poolCallData.push({
      target: pool.address,
      callData: this.poolInterface.encodeFunctionData('getTargets'),
    });
    return poolCallData;
  }

  /*
    Helper function to decodes multicall data for a Linear Pool.
    data must contain returnData
    startIndex is where to start in returnData. Allows this decode function to be called along with other pool types.
    */
  decodeOnChainCalls(
    pool: SubgraphPoolBase,
    data: { success: boolean; returnData: any }[],
    startIndex: number,
  ): [{ [address: string]: PoolState }, number] {
    const pools = {} as { [address: string]: PoolState };

    const poolTokens = decodeThrowError(
      this.vaultInterface,
      'getPoolTokens',
      data[startIndex++],
      pool.address,
    );
    const swapFee = decodeThrowError(
      this.poolInterface,
      'getSwapFeePercentage',
      data[startIndex++],
      pool.address,
    )[0];
    const scalingFactors = decodeThrowError(
      this.poolInterface,
      'getScalingFactors',
      data[startIndex++],
      pool.address,
    )[0];
    const [lowerTarget, upperTarget] = decodeThrowError(
      this.poolInterface,
      'getTargets',
      data[startIndex++],
      pool.address,
    );

    const bptIndex = pool.tokens.findIndex(
      t => t.address.toLowerCase() === pool.address.toLowerCase(),
    );

    const poolState: PoolState = {
      swapFee: BigInt(swapFee.toString()),
      mainIndex: Number(pool.mainIndex),
      wrappedIndex: Number(pool.wrappedIndex),
      bptIndex,
      lowerTarget: BigInt(lowerTarget.toString()),
      upperTarget: BigInt(upperTarget.toString()),
      tokens: poolTokens.tokens.reduce(
        (ptAcc: { [address: string]: TokenState }, pt: string, j: number) => {
          const tokenState: TokenState = {
            balance: BigInt(poolTokens.balances[j].toString()),
          };

          if (scalingFactors)
            tokenState.scalingFactor = BigInt(scalingFactors[j].toString());

          ptAcc[pt.toLowerCase()] = tokenState;
          return ptAcc;
        },
        {},
      ),
    };

    pools[pool.address] = poolState;

    return [pools, startIndex];
  }

  /*
  Swapping to BPT allows for a very large amount as pre-minted.
  Swapping to main token - you can use 99% of the balance of the main token (Dani)
  */
  checkBalance(
    amounts: bigint[],
    unitVolume: bigint,
    side: SwapSide,
    poolPairData: LinearPoolPairData,
  ): boolean {
    const swapMax =
      (this._upscale(
        poolPairData.balances[poolPairData.indexOut],
        poolPairData.scalingFactors[poolPairData.indexOut],
      ) *
        BigInt(99)) /
      BigInt(100);
    const swapAmount =
      amounts[amounts.length - 1] > unitVolume
        ? amounts[amounts.length - 1]
        : unitVolume;
    return swapMax > swapAmount;
  }
}
