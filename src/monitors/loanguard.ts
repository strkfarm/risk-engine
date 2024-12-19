// import {AutoCompounderSTRK, ContractAddr, FatalError, Global, IConfig, Initializable, logger, MarginType, Pricer, Web3Number, ZkLend} from '@strkfarm/sdk';
// import { PrismaClient, subscriptions } from '@prisma/client';
// import { Account, Call, Contract, TransactionExecutionStatus } from 'starknet';
// const assert = require('assert');
// import { readFileSync } from 'fs';
// import { log } from 'console';

// interface BalanceInfo {
//     strategy: AutoCompounderSTRK,
//     assets: Web3Number,
//     usdValue: Web3Number
// }

// export class LoanGuardService extends Initializable implements Initializable {
//     readonly config: IConfig;
//     readonly prisma = new PrismaClient();
//     readonly account: Account;

//     readonly loanGuardAddr = ContractAddr.from('0x534475ec241a43cf5da17420ef9b20409ca74563971332355ee2706d9ebafb2');
//     loanGuardContract: Contract | null = null;
//     subscriptions: subscriptions[] = [];
//     strategies: AutoCompounderSTRK[] = [];
//     zkLend: ZkLend | null = null;
//     constructor(config: IConfig) {
//         super();
//         this.config = config;
//         this.account = this.getAccount();      
//         this.init();  
//     }

//     async init() {
//         const tokens = await Global.getTokens();
//         const pricer = new Pricer(this.config, tokens);
//         await pricer.waitTillReady();

//         this.zkLend = new ZkLend(this.config, pricer);
//         await this.zkLend.waitForInitilisation();

//         const autoSTRK = new AutoCompounderSTRK(this.config, pricer);
//         await autoSTRK.waitForInitilisation();
//         this.strategies = [autoSTRK];

//         // initialize loan guard contract
//         const cls = await this.config.provider.getClassAt(this.loanGuardAddr.address);
//         this.loanGuardContract = new Contract(cls.abi, this.loanGuardAddr.address, <any>this.config.provider);
//         this.initialized = true;
//     }

//     async start() {
//         await this.loadSubscriptions();
//         logger.info(`# Number of active subscriptions: ${this.subscriptions.length}`);

//         // TODO better batching to avoid gas limit
//         const calls: Call[] = [];
//         for (let i=0; i<this.subscriptions.length; ++i) {
//             const current_hf = await this.zkLend.get_health_factor(ContractAddr.from(this.subscriptions[i].user));
//             logger.verbose(`# Current health factor: ${current_hf}, min: ${this.subscriptions[i].min_health_factor}, max: ${this.subscriptions[i].max_health_factor}`);
//             logger.verbose(`# Current user: ${this.subscriptions[i].user}`);
//             if (current_hf < this.subscriptions[i].min_health_factor) {
//                 const calldata = await this.getRebalanceIncreaseHFCalldata(
//                     ContractAddr.from(this.subscriptions[i].user),
//                     this.subscriptions[i].target_health_factor
//                 );
//                 if (calldata) {
//                     calls.push(calldata);
//                 }
//             } else if (current_hf > this.subscriptions[i].max_health_factor) {
//                 const calldata = await this.getRebalanceDecreaseHFCalldata(
//                     ContractAddr.from(this.subscriptions[i].user),
//                     this.subscriptions[i].target_health_factor
//                 );
//                 if (calldata) {
//                     calls.push(calldata);
//                 }
//             }
//         }

//         // continue after 30 seconds
//         setTimeout(() => this.start(), 30 * 1000); // 30sec

//         // execute calls
//         if (calls.length > 0) {
//             const tx = await this.account.execute(calls);
//             logger.info(`# Rebalance tx: ${tx.transaction_hash}`);
//             await this.config.provider.waitForTransaction(tx.transaction_hash, {
//                 successStates: [<any>TransactionExecutionStatus.SUCCEEDED]
//             })
//             logger.info(`# Rebalance tx confirmed: ${tx.transaction_hash}`);
//         }
//     }

//     async loadSubscriptions() {
//         let subscriptions = await this.prisma.subscriptions.findMany({
//             orderBy: {
//                 timestamp: 'asc'
//             }
//         });
//         const BASIS_POINTS_DIVISOR = 10000;
//         subscriptions = subscriptions
//         .filter((s) => s.is_active)
//         .map((s) => {
//             return {
//                 ...s,
//                 min_health_factor: s.min_health_factor / BASIS_POINTS_DIVISOR,
//                 target_health_factor: s.target_health_factor / BASIS_POINTS_DIVISOR,
//                 max_health_factor: s.max_health_factor / BASIS_POINTS_DIVISOR
//             }
//         })
//         const userSubMap: {[key: string]: subscriptions} = {};
//         for (const sub of subscriptions) {
//             userSubMap[sub.user] = sub;
//         }

//         // convert user map to array
//         this.subscriptions = Object.values(userSubMap);
//     }

//     getAccount() {
//         assert(process.env.SECRET_FILE_FOLDER, 'invalid SECRET_FILE_FOLDER')
//         assert(process.env.NETWORK, 'invalid NETWORK')
//         let data = JSON.parse(readFileSync(`${process.env.SECRET_FILE_FOLDER}/account_${process.env.NETWORK}.json`, {
//             encoding: 'utf-8'
//         }));
//         return new Account(<any>this.config.provider, data.address, data.pk);
//     }

//     async getRebalanceIncreaseHFCalldata(user: ContractAddr, target_hf: number) {
//         logger.verbose(`getRebalanceCalldata: user: ${user.address}`);
//         logger.verbose(`getRebalanceCalldata: target_hf: ${target_hf}`);

//         const balanceProms = this.strategies.map(async (strategy) => {
//             const balanceInfo = await strategy.usdBalanceOfUnderlying(user);
//             const info: BalanceInfo = {
//                 strategy: strategy,
//                 assets: balanceInfo.assets,
//                 usdValue: balanceInfo.usd
//             }
//             return info;
//         })
//         const balancesInfo: BalanceInfo[] = (await Promise.all(balanceProms)).filter((b) => !b.assets.isZero());
//         if (balancesInfo.length == 0) {
//             return null;
//         }

//         const requiredEffUsd = await this.requiredUsdToRebalance(user, target_hf);
//         const {bestStrategy, amount} = this.selectBestStrategy(balancesInfo, requiredEffUsd);
//         if (!bestStrategy) {
//             return null;
//         }

//         return this.loanGuardContract.populate('increase_hf_zkLend', {
//             user: user.address,
//             strategy: bestStrategy,
//             amount: amount.toWei()
//         });
//     }

//     selectBestStrategy(balancesInfo: BalanceInfo[], requiredEffUsd: Web3Number) {
//         let bestStrategy: string | null = null; // best strategy to use to rebalance
//         let bestEffUsd = new Web3Number(0, 6); // for comparison across strategies
//         let amount: Web3Number = new Web3Number(0, 6); // assets to use to rebalance
//         for (const balanceInfo of balancesInfo) {
//             const underlying = balanceInfo.strategy.metadata.underlying;
//             const zkLendTokenInfo = this.zkLend.tokens.find((t) => t.symbol == underlying.symbol);
//             if (!zkLendTokenInfo) {
//                 throw new FatalError(`Token ${underlying.symbol} not found in zkLend tokens`);
//             }
//             const requiredAssetUsd = requiredEffUsd.dividedBy(zkLendTokenInfo.collareralFactor.toFixed(18));
//             logger.verbose(`selectBestStrategy: requiredAssetUsd: ${requiredAssetUsd.toFixed(6)}`);

//             // current asset less than the best asset usd, so ignore
//             if (balanceInfo.usdValue.lt(bestEffUsd)) {
//                 logger.verbose(`selectBestStrategy: Ignoring ${underlying.symbol} as usd value is less than bestEffUsd`);
//                 continue;
//             } else {
//                 // current asset is more than the best asset usd, so update the best asset usd
//                 if (balanceInfo.usdValue.gte(requiredAssetUsd)) {
//                     logger.verbose(`selectBestStrategy: Updating bestEffUsd to ${underlying.symbol}`);
//                     // current asset is more than the required asset usd, so limit the amount to the required asset usd
//                     bestEffUsd = balanceInfo.usdValue;
//                     const price = this.zkLend.pricer.getPrice(underlying.name);
//                     amount = requiredAssetUsd.dividedBy(price.price.toFixed(6));
//                     amount.decimals = balanceInfo.strategy.metadata.decimals;     
//                     bestStrategy = balanceInfo.strategy.addr.address;

//                     logger.verbose(`selectBestStrategy: amount: ${amount.toFixed(6)}`); 
//                     logger.verbose(`selectBestStrategy: price: ${price.price.toFixed(6)}`); 
//                     logger.verbose(`selectBestStrategy: bestStrategy: ${bestStrategy}`);

//                 } else {
//                     // current asset is less than the required asset usd, 
//                     // use whatever is available to rebalance
//                     amount = balanceInfo.assets;
//                     bestEffUsd = balanceInfo.usdValue;
//                     bestStrategy = balanceInfo.strategy.addr.address

//                     logger.verbose(`selectBestStrategy: amount: ${amount.toFixed(6)}`);
//                     logger.verbose(`selectBestStrategy: bestStrategy: ${bestStrategy}`);
//                 }
//             }
//         }

//         logger.verbose(`selectBestStrategy: bestEffUsd: ${bestEffUsd.toFixed(6)}`);
//         logger.verbose(`selectBestStrategy: bestStrategy: ${bestStrategy}`);
//         logger.verbose(`selectBestStrategy: amount: ${amount.toFixed(6)}`);
//         logger.verbose(`selectBestStrategy: amountWei: ${amount.toWei()}`);

//         return {
//             bestStrategy,
//             amount
//         }
//     }


//     /**
//      * target hf = Sigma(new collateral usd  * collateral factor) / Sigma(borrowed usd / borrow factor)
//      * current hf = Sigma(collateral usd  * collateral factor) / Sigma(borrowed usd / borrow factor)
//      * => target_hf / current hf = (Sigma(new collateral usd  * collateral factor)) / (Sigma(collateral usd  * collateral factor))
//      */
//     async requiredUsdToRebalance(user: ContractAddr, target_hf: number) {
//         const current_hf = await this.zkLend.get_health_factor(user);
//         logger.verbose(`requiredUsdToRebalance: current_hf: ${current_hf}`);

//         const positions = await this.zkLend.getPositions(user);
//         const collateralPositions = positions
//         .filter((pos) => pos.marginType == MarginType.SHARED && pos.supplyAmount.gt(0));

//         let currentEffCollateralUsd = new Web3Number(0, 6); // 6 decimal usd value
//         for(const pos of collateralPositions) {
//             const zkLendTokenInfo = this.zkLend.tokens.find((t) => t.symbol == pos.tokenSymbol);
//             if (!zkLendTokenInfo) {
//                 throw new FatalError(`Token ${pos.tokenSymbol} not found in zkLend tokens`);
//             }
//             currentEffCollateralUsd = currentEffCollateralUsd
//             .plus(pos.supplyUSD.multipliedBy(zkLendTokenInfo.collareralFactor.toFixed(18)).toFixed(6));
//         }

//         logger.verbose(`requiredUsdToRebalance: currentEffCollateralUsd: ${currentEffCollateralUsd.toFixed(6)}`);
//         const requiredEffCollateralUSDNumerator = currentEffCollateralUsd.multipliedBy((target_hf / current_hf).toFixed(6));
//         logger.verbose(`requiredUsdToRebalance: requiredEffCollateralUSDNumerator: ${requiredEffCollateralUSDNumerator.toFixed(6)}`);
//         if (current_hf < target_hf) {
//             return requiredEffCollateralUSDNumerator.minus(currentEffCollateralUsd.toFixed(6));
//         } else {
//             return currentEffCollateralUsd.minus(requiredEffCollateralUSDNumerator.toFixed(6));
//         }
//     }

//     async getRebalanceDecreaseHFCalldata(user: ContractAddr, target_hf: number) {
//         logger.verbose(`getRebalanceCalldata: user: ${user.address}`);
//         logger.verbose(`getRebalanceCalldata: target_hf: ${target_hf}`);

//         const requiredEffUsd = await this.requiredUsdToRebalance(user, target_hf);
//         const result = await this.selectZkLendVault(user, requiredEffUsd);
//         if (!result) {
//             return null;
//         }

//         const {strategy, amount, token} = result;

//         return this.loanGuardContract.populate('decrease_hf_zkLend', {
//             user: user.address,
//             withdraw_amount: amount.toWei(),
//             withdraw_token: token.address,
//             strategy: strategy.addr.address
//         });
//     }

//     async selectZkLendVault(user: ContractAddr, requiredEffUsd: Web3Number) {
//         // get all the positions
//         const positions = await this.zkLend.getPositions(user);

//         // get all the collateral positions
//         const collateralPositions = positions
//         .filter((pos) => {
//             return pos.marginType == MarginType.SHARED 
//             && pos.supplyAmount.gt(0) &&
//             this.strategies.filter((s) => s.metadata.underlying.symbol == pos.tokenSymbol).length > 0;
//         });

//         logger.verbose(`selectZkLendVault: #collateral positions: ${collateralPositions.length}`);

//         // use one that has required collateral
//         for (const pos of collateralPositions) {
//             const zkLendTokenInfo = this.zkLend.tokens.find((t) => t.symbol == pos.tokenSymbol);
//             if (!zkLendTokenInfo) {
//                 throw new FatalError(`Token ${pos.tokenSymbol} not found in zkLend tokens`);
//             }
            
//             const effCollateralUsd = pos.supplyUSD.multipliedBy(zkLendTokenInfo.collareralFactor.toFixed(18));
//             if (effCollateralUsd.gte(requiredEffUsd)) {
//                 const price = this.zkLend.pricer.getPrice(pos.tokenSymbol);
//                 const amount = requiredEffUsd
//                     .dividedBy(zkLendTokenInfo.collareralFactor.toFixed(18))
//                     .dividedBy(price.price.toFixed(6));
//                 const strategy = this.strategies.find((s) => s.metadata.underlying.symbol == pos.tokenSymbol);
//                 amount.decimals = strategy.metadata.decimals;
//                 logger.verbose(`selectZkLendVault: amount: ${amount.toFixed(6)}`);
//                 logger.verbose(`selectZkLendVault: amountWei: ${amount.toWei()}`);
//                 logger.verbose(`selectZkLendVault: price: ${price.price.toFixed(6)}`);
//                 logger.verbose(`selectZkLendVault: strategy: ${strategy.addr.address}`);
//                 logger.verbose(`selectZkLendVault: token: ${strategy.metadata.underlying.address}`);
//                 return {
//                     strategy,
//                     amount: amount,
//                     token: strategy.metadata.underlying.address
//                 }
//             }
//         }

//         return null;
//     }
// }


// // token names messedup