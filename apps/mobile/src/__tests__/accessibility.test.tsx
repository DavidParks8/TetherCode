jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  findNodeHandle: jest.fn(),
}));

import { AccessibilityInfo, findNodeHandle, Text, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

function AnnouncementProbe({ message }: { message: string | null }) {
  useAccessibilityAnnouncement(message);
  return <Text>{message}</Text>;
}

function FocusProbe({ visible, delayMs = 350 }: { visible: boolean; delayMs?: number }) {
  const focusRef = useModalAccessibilityFocus(visible, delayMs);
  return <View ref={focusRef} />;
}

describe('accessibility helpers', () => {
  it('builds explicit control state without inventing optional state', () => {
    expect(controlAccessibilityState({ disabled: true, selected: false, expanded: true, busy: true }))
      .toEqual({ disabled: true, selected: false, expanded: true, busy: true });
    expect(controlAccessibilityState({})).toEqual({ disabled: false });
  });

  it('hides decorative descendants from accessibility', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<View {...decorativeAccessibilityProps} />);
    });

    expect(tree?.root.findByType(View).props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no',
    });
  });

  it('announces changed non-empty messages once', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(<AnnouncementProbe message="Loading" />);
    });
    act(() => {
      tree?.update(<AnnouncementProbe message="Loading" />);
    });
    act(() => {
      tree?.update(<AnnouncementProbe message="Ready" />);
    });

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenNthCalledWith(1, 'Loading');
    expect(announce).toHaveBeenNthCalledWith(2, 'Ready');
    announce.mockRestore();
  });

  it('resets announcement deduplication after an empty message', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(<AnnouncementProbe message=" Loading " />);
    });
    act(() => tree?.update(<AnnouncementProbe message="  " />));
    act(() => tree?.update(<AnnouncementProbe message="Loading" />));

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenCalledWith('Loading');
    announce.mockRestore();
  });

  it('focuses a visible modal after the delay and cancels stale timers', () => {
    jest.useFakeTimers();
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation();
    const nodeHandle = findNodeHandle as jest.MockedFunction<typeof findNodeHandle>;
    nodeHandle.mockReturnValue(42);
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(<FocusProbe visible={false} delayMs={20} />);
    });
    act(() => tree?.update(<FocusProbe visible delayMs={20} />));
    act(() => jest.advanceTimersByTime(20));
    expect(focus).toHaveBeenCalledWith(42);

    focus.mockClear();
    act(() => tree?.update(<FocusProbe visible delayMs={30} />));
    act(() => tree?.update(<FocusProbe visible={false} delayMs={30} />));
    act(() => jest.runOnlyPendingTimers());
    expect(focus).not.toHaveBeenCalled();

    focus.mockRestore();
    nodeHandle.mockReset();
    jest.useRealTimers();
  });

  it('does not focus when the view has no native handle', () => {
    jest.useFakeTimers();
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation();
    const nodeHandle = findNodeHandle as jest.MockedFunction<typeof findNodeHandle>;
    nodeHandle.mockReturnValue(null);

    act(() => {
      renderer.create(<FocusProbe visible delayMs={0} />);
    });
    act(() => jest.runOnlyPendingTimers());

    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    nodeHandle.mockReset();
    jest.useRealTimers();
  });
});
