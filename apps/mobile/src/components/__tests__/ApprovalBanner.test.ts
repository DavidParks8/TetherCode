import { runApprovalResolution } from '../ApprovalBanner';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  FadeInDown: { duration: () => undefined },
}));

describe('ApprovalBanner', () => {
  it('returns an awaitable resolution and restores controls after failure', async () => {
    const setResolving = jest.fn();
    const resolve = jest.fn().mockRejectedValue(new Error('temporary failure'));

    await expect(
      runApprovalResolution('approval-1', 'accept', resolve, setResolving)
    ).rejects.toThrow('temporary failure');
    expect(setResolving.mock.calls).toEqual([['accept'], [null]]);
  });
});
