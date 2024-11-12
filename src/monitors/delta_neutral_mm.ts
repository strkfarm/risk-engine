import { pollHeartbeat } from "@/utils";
import assert from "assert";
import BigNumber from "bignumber.js";
import { Account, Call, Contract, uint256 } from "starknet";
import { FatalError } from "strkfarm-sdk";
import { PricerRedis } from "strkfarm-sdk";
import { getDefaultStoreConfig } from "strkfarm-sdk";
import { Network } from "strkfarm-sdk";
import { ContractAddr, Global, IConfig, ILendingPosition, 
    logger, Pricer, Store, TelegramNotif, ZkLend, Pragma } from "strkfarm-sdk";

export interface ContractInfo {
    address: string,
    name: string,
    minHfBasisPoints: BigInt,
    targetHfBasisPoints: BigInt,
    mainToken: string,
    secondaryToken: string,
    is_inverted?: boolean,
}

export class DeltaNeutraMM {
    readonly config: IConfig;
    readonly contractsInfo: ContractInfo[] = [{
        name: 'DeltaNeutralLoopingUSDCETH',
        address: '0x4937b58e05a3a2477402d1f74e66686f58a61a5070fcc6f694fb9a0b3bae422',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'USDC',
        secondaryToken: 'ETH',
    }, {
        name: 'DeltaNeutralLoopingSTRKETH',
        address: '0x20d5fc4c9df4f943ebb36078e703369c04176ed00accf290e8295b659d2cea6',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'STRK',
        secondaryToken: 'ETH',
    }, {
        name: 'DeltaNeutralLoopingETHUSDC',
        address: '0x9d23d9b1fa0db8c9d75a1df924c3820e594fc4ab1475695889286f3f6df250',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'ETH',
        secondaryToken: 'USDC',
    }, {
        name: 'DeltaNeutralLoopingETHUSDC2',
        address: '0x9140757f8fb5748379be582be39d6daf704cc3a0408882c0d57981a885eed9',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'ETH',
        secondaryToken: 'USDC',
        is_inverted: true,
    }];

    readonly contracts: {[key: string]: Contract} = {}
    readonly pragma: Pragma;
    zkLend: ZkLend;
    private initialised = false;
    readonly account: Account;
    readonly telegramNotif: TelegramNotif;
    private isFirstRun = true;

    ERRORS = {
        ZKLEND_LOW_HF: 'ZkLend:: low health factor',
        NOSTRA_LOW_HF: 'Nostra:: low health factor',
    }
    constructor(config: IConfig) {
        this.config = config;
        const defaultStoreConfig = getDefaultStoreConfig(<Network>process.env.NETWOR);
        defaultStoreConfig.PASSWORD = process.env.ACCOUNT_SECURE_PASSWORD;
        defaultStoreConfig.ACCOUNTS_FILE_NAME = 'accounts-risk.json'
        const store = new Store(this.config, defaultStoreConfig);
        
        if (!process.env.ACCOUNT_NAME) {
            throw new Error('ACCOUNT_NAME not set');
        }
        this.account = <any>store.getAccount(process.env.ACCOUNT_NAME);
        this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
        this.pragma = new Pragma(this.config.provider);
        this.init();
    }

    async init() {
        this.telegramNotif.sendMessage(`Starting Delta Neutral MM risk manager`);
        const cls = await this.config.provider.getClassAt(this.contractsInfo[0].address);
        this.contractsInfo.forEach(c => {
            this.contracts[c.name] = new Contract(cls.abi, c.address, <any>this.config.provider)
        })
        await this.loadSettings();

        const tokens = await Global.getTokens();
        const pricer = new PricerRedis(this.config, tokens);
        if (!process.env.REDIS_URL) {
          throw new FatalError('REDIS_URL not set');
        }
        await pricer.initRedis(process.env.REDIS_URL);
        this.zkLend = new ZkLend(this.config, pricer);
        await this.zkLend.waitForInitilisation();
        this.initialised = true;
    }

    waitForInitialisation() {
        return new Promise<void>((resolve, reject) => {
            const interval = setInterval(() => {
                if (this.initialised) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        })
    }

    async start() {
        try {
            pollHeartbeat();
            const calls = await this.shouldRebalance();
            if (calls.length > 0) {
                try {
                    this.isFirstRun = true;
                    console.log(`Submitting batch of ${calls.length} calls`);
                    this.telegramNotif.sendMessage(`Submitting batch of ${calls.length} calls ♻️`);
                    // execute calls
                    const tx = await this.account.execute(calls);
                    logger.info(`Transaction submitted: ${tx.transaction_hash}`);
                    const receipt = await this.config.provider.waitForTransaction(tx.transaction_hash);
                    if (receipt.statusReceipt == 'success') {
                        logger.info(`Transaction confirmed: ${tx.transaction_hash}`);
                        this.telegramNotif.sendMessage(`DNMM:: Completed ${calls.length} rebalances ✅`);
                    } else {
                        logger.error(`Transaction failed: ${tx.transaction_hash}`);
                        this.telegramNotif.sendMessage(`DNMM:: Transaction failed ❌`);
                        throw new Error(`Transaction failed: ${tx.transaction_hash}`);
                        // const err = await this.account.getTransactionTrace(tx.transaction_hash);
                    }
                } catch(err) {
                    console.error(`DNMM Risk error`, err);
                    this.telegramNotif.sendMessage(`DNMM Risk error ⚠️☠️🚨⚠️☠️🚨`)
                }
            }
        } catch(err) {
            console.error(`DNMM Risk error`, err);
            this.isFirstRun = true;
            this.telegramNotif.sendMessage(`DNMM Risk error ⚠️☠️🚨`)
            this.telegramNotif.sendMessage(`Wait sometime. If keeps repeating, you should intervene`);
        }

        setTimeout(async () => {
            this.start();
        }, 120 * 1000); // 2 minutes
    }

    async shouldRebalance() {
        const calls: Call[]  = [];
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.call('health_factors', [])
            const hf1 = result[0];
            const hf2 = result[1];
            const now = new Date();
            if (now.getHours() % 3 == 0 && now.getMinutes() <= 5 || this.isFirstRun) {
                this.telegramNotif.sendMessage(`${this.contractsInfo[i].name}:: Current health factors: ${hf1}, ${hf2}`);
            }

            console.log(this.contractsInfo[i], hf1, hf2);
            // if either health factor is below the minimum, we should rebalance
            if (hf1 < this.contractsInfo[i].minHfBasisPoints || hf2 < this.contractsInfo[i].minHfBasisPoints) {
                console.log(`Rebalancing ${this.contractsInfo[i].name}`);
                const call = await this.generateRebalanceCall(hf1, hf2, this.contractsInfo[i], contract);
                calls.push(call);
            }
        }

        console.log(`Rebalancing calls: ${calls.length}`);
        this.isFirstRun = false;
        return calls;
    }

    async generateRebalanceCall(currentHf1: BigInt, currentHf2: BigInt, contractInfo: ContractInfo, contract: Contract) {
        const zkLendPositions = await this.zkLend.getPositions(ContractAddr.from(contract.address));
        const minHf: BigInt = contractInfo.minHfBasisPoints;
        if (currentHf1 < minHf) {
            // e.g. zkLend is unhealth. repay some debt in zklend by withdrawing from nostra
            const debtToRepay = await this.requiredDebtToRepay(contractInfo, Number(contractInfo.targetHfBasisPoints), zkLendPositions);
            logger.verbose(`generateRebalanceCall:: debtToRepay: ${debtToRepay}`);
            let amount = debtToRepay;
            let attempt = 1;
            let factorBasisPercent = 50;
            while (attempt < 30) {
                try {
                    logger.info(`Checking amount: ${amount}, shouldRepay: true`);
                    const call = contract.populate('rebalance', {
                        amount: uint256.bnToUint256(amount.toString()),
                        shouldRepay: true,
                    });
                    const est = await this.account.estimateFee([call]);
                    logger.info(`Using amount: ${amount.toString()}, shouldRepay: true`);
                    this.telegramNotif.sendMessage(`Calldata: amount ${amount.toString()}, shouldRepay: 1`)
                    return call;
                } catch(err) {
                    attempt++;
                    console.log(`estimate failed2`)
                    if (attempt >= 30) {
                        this.telegramNotif.sendMessage(`Failed to estimate fee after 30 attempts, error: ${err.message}`);
                        throw err;
                    }
                    const isLowZkLendHf = err.message.includes(this.ERRORS.ZKLEND_LOW_HF);
                    const isLowNostraHf = err.message.includes(this.ERRORS.NOSTRA_LOW_HF);
                    if (isLowZkLendHf) {
                        // increase amount by factorPercent and check
                        logger.info(`zkLendHFLow: Increasing amount by ${factorBasisPercent}`);
                        amount = (new BigNumber(amount)).mul(10000 + factorBasisPercent).div(10000).toFixed(0);
                    } else if (isLowNostraHf) {
                        // decrease amount by factorPercent and check
                        logger.info(`nostraHfLow: decreasing amount by ${factorBasisPercent}`);
                        amount = (new BigNumber(amount)).mul(10000 - factorBasisPercent).div(10000).toFixed(0);
                    } else {
                        this.telegramNotif.sendMessage(`Unexpected Error: ${err.message}`);
                        throw err;
                    }
                    await new Promise((res) => setTimeout(res, 1000))
                }
            }
        } else if (currentHf2 < contractInfo.minHfBasisPoints) {
            // e.g. nostra is unhealth. add collateral in nostra by borrowing from zkLend
            const debtToBorrow = await this.requiredDebtToRepay(contractInfo, Number(contractInfo.targetHfBasisPoints), zkLendPositions);
            logger.verbose(`generateRebalanceCall:: debtToBorrow: ${debtToBorrow}`);
            let amount = debtToBorrow;
            let attempt = 1;
            let factorBasisPercent = 50;
            while (attempt < 30) {
                try {
                    logger.info(`Checking amount: ${amount}, shouldRepay: false`);
                    const call = contract.populate('rebalance', {
                        amount: uint256.bnToUint256(amount.toString()),
                        shouldRepay: false,
                    });
                    const est = await this.account.estimateFee([call]);
                    logger.info(`Using amount: ${amount.toString()}`);
                    this.telegramNotif.sendMessage(`Calldata: amount ${amount.toString()}, shouldRepay: 0`)
                    return call;
                } catch(err) {
                    attempt++;
                    console.log(`estimate failed`)
                    if (attempt >= 30) {
                        this.telegramNotif.sendMessage(`Failed to estimate fee after 30 attempts, error: ${err.message}`);
                        throw err;
                    }
                    const isLowZkLendHf = err.message.includes(this.ERRORS.ZKLEND_LOW_HF);
                    const isLowNostraHf = err.message.includes(this.ERRORS.NOSTRA_LOW_HF);
                    if ((!contractInfo.is_inverted && isLowZkLendHf) || (contractInfo.is_inverted && isLowNostraHf)) {
                        amount = (new BigNumber(amount)).mul(10000 - factorBasisPercent).div(10000).toFixed(0);
                    } else if ((!contractInfo.is_inverted && isLowNostraHf) || (contractInfo.is_inverted && isLowZkLendHf)) {
                        amount = (new BigNumber(amount)).mul(10000 + factorBasisPercent).div(10000).toFixed(0);
                    } else {
                        this.telegramNotif.sendMessage(`Unexpected Error: ${err.message}`);
                        throw err;
                    }
                    await new Promise((res) => setTimeout(res, 1000))
                }
            }
        } else {
            throw new Error('Invalid health factors');
        }
    }

    async computeHealthFactor() {
        const borrowAmount = 0n;
        const borrowFactor = 0n;
        const borrowPrice = 0n;
        const collateralAmount = 0n;
        const collateralFactor = 0n;
        const collateralPrice = 0n;

        return (collateralAmount * collateralFactor * collateralPrice * borrowFactor) / (borrowAmount * borrowPrice);
    }

    async requiredDebtToRepay(contractInfo: ContractInfo, requiredHf: number, positions: ILendingPosition[]) {
        const mainToken = contractInfo.is_inverted ? contractInfo.secondaryToken : contractInfo.mainToken;
        const secondaryToken = contractInfo.is_inverted ? contractInfo.mainToken : contractInfo.secondaryToken;
        const collateralAmount = positions.find(p => p.tokenSymbol === mainToken)?.supplyAmount;
        const mainTokenInfo = this.zkLend.tokens.find(t => t.symbol === mainToken);
        if (!mainTokenInfo) {
            throw new FatalError('Main token info not found');
        }
        const colPrice = await this.pragma.getPrice(mainTokenInfo.address);
        const collateralUsd = collateralAmount.multipliedBy(colPrice);
        if (!collateralUsd) {
            throw new FatalError('Collateral amount not found');
        }
        const collateralFactor = mainTokenInfo?.collareralFactor;
        if (!collateralFactor) {
            throw new FatalError('Collateral factor not found');
        }
        logger.info(`requiredDebtToRepay:: collateralAmount: ${collateralUsd}, collateralFactor: ${collateralFactor}`);

        const borrowAmount = positions.find(p => p.tokenSymbol === secondaryToken)?.debtAmount;
        if (!borrowAmount) {
            throw new FatalError('Borrow amount not found');
        }
        const secondaryTokenInfo = this.zkLend.tokens.find(t => t.symbol === secondaryToken);
        if(!secondaryTokenInfo) {
            throw new FatalError('Secondary token info not found');
        }
        const borrowPrice = await this.pragma.getPrice(secondaryTokenInfo?.address || '');
        const borrowFactor = secondaryTokenInfo?.borrowFactor;
        if (!borrowFactor) {
            throw new FatalError('Borrow factor not found');
        }
        logger.info(`requiredDebtToRepay:: borrowFactor: ${borrowFactor}`);

        // if not inverted
        if (!contractInfo.is_inverted) {
            // ! todo why not use borrow factor?
            const requiredDebt = collateralUsd
                .multipliedBy(collateralFactor.toFixed(6))
                .multipliedBy(borrowFactor.toFixed(6))
                .dividedBy(requiredHf / 10000)
                .dividedBy(borrowPrice);
            requiredDebt.decimals = borrowAmount.decimals
            logger.info(`requiredDebtToRepay:: requiredDebt: ${requiredDebt}`);
            logger.info(`requiredDebtToRepay:: borrowAmount: ${borrowAmount}`);

            if (requiredDebt.lt(borrowAmount)) {
                return borrowAmount.minus(requiredDebt.toFixed(6)).toWei();
            } else {
                return requiredDebt.minus(borrowAmount.toFixed(6)).toWei();
            }
        } else {
            const borrowUsd = borrowAmount.multipliedBy(borrowPrice);
            const requiredCollateral = borrowUsd.multipliedBy(requiredHf / 10000)
                                        .dividedBy(colPrice)
                                        .dividedBy(collateralFactor.toFixed(6))
                                        .dividedBy(borrowFactor.toFixed(6));
            requiredCollateral.decimals = collateralAmount.decimals;
            logger.info(`requiredDebtToRepay:: requiredCollateral: ${requiredCollateral}`);
            logger.info(`requiredDebtToRepay:: collateralAmount: ${collateralAmount}`);

            if (requiredCollateral.lt(collateralAmount)) {
                return collateralAmount.minus(requiredCollateral.toFixed(6)).toWei();
            } else {
                return requiredCollateral.minus(collateralAmount.toFixed(6)).toWei();
            }
        }
    }


    async loadSettings() {
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.get_settings();
            this.contractsInfo[i].minHfBasisPoints = BigInt(12500); // result.min_health_factor;
            this.contractsInfo[i].targetHfBasisPoints = result.target_health_factor;
        }
    }
}