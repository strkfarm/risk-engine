import './mocks/sdk.mocks';
import { DeltaNeutraMM } from "@/monitors/delta_neutral_mm";
import { getMainnetConfig } from "strkfarm-sdk";

describe("Delta neutral MM", () => {
    jest.setTimeout(10000);

    const SIMULATION_BLOCK = 663253;
    // Init class
    const config = getMainnetConfig(undefined, SIMULATION_BLOCK);
    let dnmm: DeltaNeutraMM;

    beforeEach(async () => {
        dnmm = new DeltaNeutraMM(config);
        await dnmm.waitForInitialisation();
    })

    it ("shouldRebalance: true", async () => {
        // adjust min hf to 1.25 to simulate a rebalance
        dnmm.contractsInfo.forEach(async (c) => {
            c.minHfBasisPoints = BigInt(12500);
        });

        const calls = await dnmm.shouldRebalance();
        console.log(`calls: ${calls.length}`);
        expect(calls.length).toBeTruthy();
    })

    it ("shouldRebalance: false", async () => {
        // with default min hf as 1.2, shouldnt rebalance
        const calls = await dnmm.shouldRebalance();
        console.log(`calls: ${calls.length}`);
        expect(calls.length).toBeFalsy();
    })
})