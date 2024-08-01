import { Account, RpcProvider } from "starknet";
import { getMainnetConfig } from "strkfarm-sdk";


const mockGetAccount = jest.fn().mockReturnValue(new Account(
  new RpcProvider({nodeUrl: 'http://localhost:8545'}),
  '0x1234567890123456789012345678901234567890',
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
));

const MockStore = jest.fn().mockImplementation(() => ({
  getAccount: mockGetAccount
}));

jest.mock('strkfarm-sdk', () => {
  const actualSdk = jest.requireActual('strkfarm-sdk');
  return {
    ...actualSdk,
    Store: MockStore
  }
});