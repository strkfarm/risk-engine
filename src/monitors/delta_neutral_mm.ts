import { IConfig } from "src/main";
import { Call, Contract, uint256 } from "starknet";

export interface ContractInfo {
    address: string,
    name: string,
    minHfBasisPoints: BigInt,
    targetHfBasisPoints: BigInt,
}

export class DeltaNeutraMM {
    readonly config: IConfig;
    readonly contractsInfo: ContractInfo[] = [{
        name: 'DeltaNeutralLoopingUSDCETH',
        address: '0x4937b58e05a3a2477402d1f74e66686f58a61a5070fcc6f694fb9a0b3bae422',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
    }];

    readonly contracts: {[key: string]: Contract} = {}
    private initialised = false;
    constructor(config: IConfig) {
        this.config = config;
        this.init();
    }

    async init() {
        const cls = await this.config.provider.getClassAt(this.contractsInfo[0].address);
        this.contractsInfo.forEach(c => {
            this.contracts[c.name] = new Contract(cls.abi, c.address, this.config.provider)
        })
        await this.loadSettings();
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
        setInterval(async () => {
            const calls = await this.shouldRebalance();
            if (calls.length > 0) {
                // await this.config.provider.submitBatch(calls);
                // execute calls
            }
        }, 5 * 60 * 1000); // 5 minutes
    }

    async shouldRebalance() {
        const calls: Call[]  = [];
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.call('health_factors', [])
            const hf1 = result[0];
            const hf2 = result[1];

            // if either health factor is below the minimum, we should rebalance
            if (hf1 < this.contractsInfo[i].minHfBasisPoints || hf2 < this.contractsInfo[i].minHfBasisPoints) {
                console.log(`Rebalancing ${this.contractsInfo[i].name}`);
                const call = await this.generateRebalanceCall(hf1, hf2, this.contractsInfo[i], contract);
                calls.push(call);
            }
        }

        console.log(`Rebalancing calls: ${calls.length}`)
        return calls;
    }

    async generateRebalanceCall(currentHf1: BigInt, currentHf2: BigInt, contractInfo: ContractInfo, contract: Contract) {
        if (currentHf1 < contractInfo.minHfBasisPoints) {
            // e.g. zkLend is unhealth. repay some debt in zklend by withdrawing from nostra
            const debtToRepay = await this.requiredDebtToRepay(BigInt(contractInfo.targetHfBasisPoints.toString()));
            return contract.populate('rebalance', {
                amount: uint256.bnToUint256(debtToRepay.toString()),
                shouldRepay: true,
            });
        } else if (currentHf2 < contractInfo.minHfBasisPoints) {
            // e.g. nostra is unhealth. add collateral in nostra by borrowing from zkLend
            const debtToBorrow = await this.requiredDebtToRepay(BigInt(contractInfo.targetHfBasisPoints.toString()));
            return contract.populate('rebalance', {
                amount: uint256.bnToUint256(debtToBorrow.toString()),
                shouldRepay: false,
            });
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

    async requiredDebtToRepay(requiredHf: bigint) {
        const borrowAmount = 0n;
        const borrowFactor = 0n;
        const borrowPrice = 0n;
        const collateralAmount = 0n;
        const collateralFactor = 0n;
        const collateralPrice = 0n;

        const requiredDebt = (collateralAmount * collateralFactor * collateralPrice * borrowFactor) / (requiredHf * borrowPrice);
        if (requiredDebt > borrowAmount) {
            return borrowAmount - requiredDebt;
        } else {
            return requiredDebt - borrowAmount;
        }
    }


    async loadSettings() {
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.get_settings();
            this.contractsInfo[i].minHfBasisPoints = result.min_health_factor;
            this.contractsInfo[i].targetHfBasisPoints = result.target_health_factor;
        }
    }
}