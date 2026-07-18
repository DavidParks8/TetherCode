import React from 'react';
import { Platform } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentController,
  addUniqueAttachmentPath,
  attachmentSizeError,
  retainFailedPreparedAttachment,
  useAttachmentController,
} from '../attachmentController';

const documentPicker = DocumentPicker.getDocumentAsync as jest.Mock;
const getInfo = FileSystem.getInfoAsync as jest.Mock;
const manipulate = ImageManipulator.ImageManipulator.manipulate as jest.Mock;
const mediaPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const cameraPermission = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const launchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const launchCamera = ImagePicker.launchCameraAsync as jest.Mock;

function makeHarness(workspace: string | null = '/repo', draft = '') {
  const api = {
    execTerminal: jest.fn().mockResolvedValue({ code: 0, stdout: 'src/a.ts\n image.png \n\n' }),
    uploadAttachment: jest.fn().mockResolvedValue({ kind: 'file', path: '/repo/uploaded.txt' }),
  };
  const setError = jest.fn();
  let current: AttachmentController;
  let draftValue = draft;
  function Probe(props: { workspace: string | null; draft: string }) {
    const [localDraft, setLocalDraft] = React.useState(props.draft);
    React.useEffect(() => setLocalDraft(props.draft), [props.draft]);
    draftValue = localDraft;
    current = useAttachmentController({
      api: api as never,
      chat: { id: 'thread-1' } as never,
      workspace: props.workspace,
      draft: localDraft,
      setDraft: setLocalDraft,
      setError,
    });
    return null;
  }
  let tree: ReactTestRenderer;
  return {
    api,
    setError,
    get current() { return current!; },
    get draft() { return draftValue; },
    async mount(props = { workspace, draft }) {
      await act(async () => { tree = renderer.create(React.createElement(Probe, props)); });
    },
    async update(props: { workspace: string | null; draft: string }) {
      await act(async () => { tree!.update(React.createElement(Probe, props)); });
    },
    unmount() { act(() => tree!.unmount()); },
  };
}

async function runAction(controller: AttachmentController, action: Parameters<AttachmentController['requestMenuAction']>[0]) {
  act(() => controller.requestMenuAction(action));
  await act(async () => { jest.advanceTimersByTime(180); await Promise.resolve(); });
}

describe('attachmentController', () => {
  it('normalizes and deduplicates attachment paths case-insensitively', () => {
    expect(addUniqueAttachmentPath(['/repo/File.ts'], ' /repo/file.ts ')).toEqual([
      '/repo/File.ts',
    ]);
    expect(addUniqueAttachmentPath([], ' /repo/new.ts ')).toEqual(['/repo/new.ts']);
  });

  it('rejects empty paths', () => {
    expect(addUniqueAttachmentPath([], '  ')).toBeNull();
  });

  it('rejects only files above the displayed attachment limit', () => {
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES)).toBeNull();
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES + 1)).toContain('20 MB');
  });

  it('retains prepared attachment metadata after an upload failure', () => {
    const prepared = {
      id: 'file:file:///cache/report.pdf',
      uri: 'file:///cache/report.pdf',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      kind: 'file' as const,
      sizeBytes: 1024,
      status: 'uploading' as const,
    };
    expect(retainFailedPreparedAttachment([prepared], prepared.id)).toEqual([
      { ...prepared, status: 'failed' },
    ]);
    expect(retainFailedPreparedAttachment([prepared], 'other')).toEqual([prepared]);
  });

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, 'requestIdleCallback', {
      configurable: true,
      value: (callback: () => void) => { callback(); return 1; },
    });
    Object.defineProperty(globalThis, 'cancelIdleCallback', { configurable: true, value: jest.fn() });
    getInfo.mockReset().mockResolvedValue({ exists: true, isDirectory: false, size: 100 });
    documentPicker.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    mediaPermission.mockReset().mockResolvedValue({ granted: true });
    cameraPermission.mockReset().mockResolvedValue({ granted: true });
    launchLibrary.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    launchCamera.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    const saveAsync = jest.fn().mockResolvedValue({ uri: 'file:///prepared.jpg' });
    const renderAsync = jest.fn().mockResolvedValue({ saveAsync });
    manipulate.mockReset().mockReturnValue({ resize: jest.fn(), renderAsync });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
  });

  it('loads and caches workspace candidates, including failures and workspace removal', async () => {
    const harness = makeHarness();
    await harness.mount();
    expect(harness.current.fileCandidates).toEqual(['src/a.ts', 'image.png']);
    expect(harness.current.mentionSuggestions('a')).toEqual(expect.any(Array));

    act(() => harness.current.openMenu());
    expect(harness.current.attachmentMenuVisible).toBe(true);
    act(() => harness.current.closeMenu());
    await runAction(harness.current, 'workspace-path');
    expect(harness.current.attachmentModalVisible).toBe(true);
    act(() => harness.current.closePathModal());

    harness.api.execTerminal.mockResolvedValueOnce({ code: 1, stdout: 'ignored' });
    await harness.update({ workspace: '/other', draft: '' });
    expect(harness.current.fileCandidates).toEqual([]);
    harness.api.execTerminal.mockRejectedValueOnce(new Error('offline'));
    await harness.update({ workspace: '/third', draft: '' });
    expect(harness.current.fileCandidates).toEqual([]);
    await harness.update({ workspace: '/repo', draft: '' });
    expect(harness.current.fileCandidates).toEqual(['src/a.ts', 'image.png']);
    await harness.update({ workspace: null, draft: '' });
    expect(harness.current.loadingFileCandidates).toBe(false);
    await runAction(harness.current, 'workspace-path');
    expect(harness.current.attachmentModalVisible).toBe(true);
    harness.unmount();

    const blankWorkspace = makeHarness(' ');
    await blankWorkspace.mount();
    expect(blankWorkspace.current.fileCandidates).toEqual([]);
    blankWorkspace.unmount();
  });

  it('adds, deduplicates, selects, removes, clears, and projects paths', async () => {
    const harness = makeHarness('/repo', '@a');
    await harness.mount();
    act(() => harness.current.submitPath());
    expect(harness.setError).toHaveBeenCalledWith('Enter a file path to attach');
    act(() => harness.current.setAttachmentPathDraft('/repo/a.ts'));
    act(() => harness.current.submitPath());
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    act(() => harness.current.selectPathSuggestion('/repo/A.ts'));
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);

    act(() => harness.current.selectMentionSuggestion('/repo/src/a.ts'));
    expect(harness.draft).toContain('@a.ts');
    expect(harness.current.toTurnInputs('/repo').mentions).toHaveLength(2);
    act(() => harness.current.removeComposerAttachment('file:/repo/a.ts'));
    act(() => harness.current.removeMentionPath('/repo/src/a.ts'));
    act(() => harness.current.removeComposerAttachment('unknown'));
    expect(harness.current.pendingMentionPaths).toEqual([]);
    act(() => harness.current.clearPending());
    act(() => harness.current.clear());
    harness.unmount();
  });

  it('picks files, rejects oversized files, uploads files, and retries failures', async () => {
    const harness = makeHarness();
    await harness.mount();
    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///large.pdf', name: 'large.pdf', size: ATTACHMENT_MAX_BYTES + 1 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.api.uploadAttachment).not.toHaveBeenCalled();

    documentPicker.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-file');

    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///report.pdf', name: 'report.pdf', mimeType: null }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/uploaded.txt']);

    harness.api.uploadAttachment.mockRejectedValueOnce(new Error('upload failed'));
    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///retry.pdf', name: 'retry.pdf', size: 100 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.hasFailedUploads).toBe(true);
    expect(harness.current.composerAttachments[0]?.label).toContain('retry');
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'file', path: '/repo/retried.pdf' });
    act(() => harness.current.retryFailedUploads());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.current.hasFailedUploads).toBe(false);
    harness.unmount();
  });

  it('prevents overlapping pickers and menu opening while picker work is active', async () => {
    let resolvePicker: (value: unknown) => void = () => undefined;
    documentPicker.mockImplementationOnce(() => new Promise((resolve) => { resolvePicker = resolve; }));
    const harness = makeHarness();
    await harness.mount();
    act(() => harness.current.requestMenuAction('phone-file'));
    act(() => { jest.advanceTimersByTime(180); });
    expect(harness.current.pickerBusy).toBe(true);
    act(() => harness.current.openMenu());
    expect(harness.current.attachmentMenuVisible).toBe(false);
    act(() => harness.current.requestMenuAction('phone-file'));
    act(() => { jest.advanceTimersByTime(180); });
    expect(documentPicker).toHaveBeenCalledTimes(1);
    await act(async () => { resolvePicker({ canceled: true, assets: [] }); await Promise.resolve(); });
    harness.unmount();
  });

  it('validates unreadable, empty, oversized, and malformed picker uploads', async () => {
    const harness = makeHarness();
    await harness.mount();
    for (const [uri, info] of [
      ['file:///missing', { exists: false, isDirectory: false, size: 1 }],
      ['file:///directory', { exists: true, isDirectory: true, size: 1 }],
      ['file:///empty', { exists: true, isDirectory: false, size: 0 }],
      ['file:///huge', { exists: true, isDirectory: false, size: ATTACHMENT_MAX_BYTES + 1 }],
    ] as const) {
      getInfo.mockResolvedValueOnce(info);
      documentPicker.mockResolvedValueOnce({ canceled: false, assets: [{ uri, name: 'file' }] });
      await runAction(harness.current, 'phone-file');
    }
    documentPicker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: ' ', name: 'bad' }] });
    await runAction(harness.current, 'phone-file');
    documentPicker.mockRejectedValueOnce(new Error('picker failed'));
    await runAction(harness.current, 'phone-file');
    expect(harness.setError).toHaveBeenCalledWith('picker failed');
    harness.unmount();
  });

  it('picks and captures images across permissions, resize directions, and upload results', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const harness = makeHarness();
    await harness.mount();
    mediaPermission.mockResolvedValueOnce({ granted: false });
    await runAction(harness.current, 'phone-image');
    expect(launchLibrary).not.toHaveBeenCalled();

    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-image');

    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///wide.png', width: 4000, height: 1000, fileName: '.png', fileSize: 100 }],
    });
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'image', path: '/repo/wide.jpg' });
    await runAction(harness.current, 'phone-image');
    expect(manipulate.mock.results.at(-1)?.value.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(harness.current.pendingLocalImagePaths).toEqual(['/repo/wide.jpg']);

    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///small', width: 10, height: 10, fileName: null }],
    });
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'image', path: ' ' });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Image path is invalid');

    cameraPermission.mockResolvedValueOnce({ granted: false });
    await runAction(harness.current, 'phone-camera');
    launchCamera.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-camera');
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tall.png', width: 1000, height: 4000, fileName: null }],
    });
    await runAction(harness.current, 'phone-camera');
    expect(manipulate.mock.results.at(-1)?.value.resize).toHaveBeenCalledWith({ height: 2048 });
    expect(harness.current.composerAttachments.some((entry) => entry.id.startsWith('image:'))).toBe(true);
    act(() => harness.current.removeComposerAttachment('image:/repo/wide.jpg'));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    harness.unmount();
  });

  it('validates source and rendered image sizes and rendered output', async () => {
    const harness = makeHarness();
    await harness.mount();
    const image = { canceled: false, assets: [{ uri: 'file:///image', width: 10, height: 10 }] };

    launchLibrary.mockResolvedValueOnce(image);
    getInfo.mockResolvedValueOnce({ exists: true, isDirectory: false, size: ATTACHMENT_MAX_BYTES + 1 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith(expect.stringContaining('20 MB'));

    launchLibrary.mockResolvedValueOnce(image);
    getInfo
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 100 })
      .mockResolvedValueOnce({ exists: false, isDirectory: false, size: 100 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Unable to prepare image');

    launchLibrary.mockResolvedValueOnce(image);
    getInfo
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 100 })
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: ATTACHMENT_MAX_BYTES + 1 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith(expect.stringContaining('Compressed image'));
    harness.unmount();
  });

  it('removes failed prepared uploads and uses a URI basename when no filename exists', async () => {
    const harness = makeHarness();
    harness.api.uploadAttachment.mockRejectedValueOnce(new Error('failed'));
    await harness.mount();
    documentPicker.mockResolvedValueOnce({
      canceled: false, assets: [{ uri: 'file:///unnamed.bin', name: undefined, size: 100 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.composerAttachments[0]?.label).toContain('unnamed.bin');
    act(() => harness.current.removeComposerAttachment(harness.current.composerAttachments[0]!.id));
    expect(harness.current.composerAttachments).toEqual([]);
    harness.unmount();
  });

  it('handles image preparation failures and submission reconciliation', async () => {
    const harness = makeHarness('/repo', '@a.ts');
    await harness.mount();
    act(() => harness.current.selectPathSuggestion('/repo/a.ts'));
    act(() => harness.current.beginSubmission());
    await harness.update({ workspace: '/repo', draft: '' });
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    act(() => harness.current.finishSubmission(false, true));
    await harness.update({ workspace: '/repo', draft: 'restored' });
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    await harness.update({ workspace: '/repo', draft: 'changed' });
    expect(harness.current.pendingMentionPaths).toEqual([]);
    act(() => harness.current.selectPathSuggestion('/repo/a.ts'));
    act(() => harness.current.finishSubmission(true));
    expect(harness.current.pendingMentionPaths).toEqual([]);

    launchLibrary.mockResolvedValueOnce({
      canceled: false, assets: [{ uri: 'file:///bad.png', width: 10, height: 10 }],
    });
    getInfo.mockResolvedValueOnce({ exists: false, isDirectory: false, size: 1 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Unable to read image');
    harness.unmount();
  });
});
