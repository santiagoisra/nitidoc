import { cleanup, render, screen } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/scanner/hooks/useActivePage', () => ({
  useActivePage: () => ({ materializeRawCapture: vi.fn(), isAtCap: false }),
}));

vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { fill?: boolean }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

import { CaptureScreen } from '@/features/scanner/components/CaptureScreen';
import { scannerStoreInitialState, useScannerStore } from '@/features/scanner/store/scannerStore';
import { ToastHost } from '@/shared/ui';

function camera(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, label, kind: 'videoinput', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

function renderToolbar(): void {
  render(
    <ToastHost>
      <CaptureScreen
        openCamera={vi.fn(async () => {})}
        switchCamera={vi.fn(async () => {})}
        setTorch={vi.fn(async () => {})}
        onBack={vi.fn()}
      />
    </ToastHost>,
  );
}

function expectClasses(element: HTMLElement, ...tokens: readonly string[]): void {
  for (const token of tokens) expect(element.classList.contains(token), `${token} class`).toBe(true);
}

describe('CaptureScreen toolbar CSS and semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScannerStore.setState({
      ...scannerStoreInitialState,
      permission: 'granted',
      devices: [
        camera('rear', 'Back Triple Camera with an intentionally long device label'),
        camera('front', 'Front Camera'),
      ],
      activeDeviceId: 'rear',
      torchSupported: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes the shrink, truncation, safe-area, torch-size, and pressed-state contracts', () => {
    renderToolbar();

    const toolbar = screen.getByTestId('capture-toolbar');
    expectClasses(
      toolbar,
      'pl-[calc(env(safe-area-inset-left)_+_0.75rem)]',
      'pr-[calc(env(safe-area-inset-right)_+_0.75rem)]',
    );

    expectClasses(screen.getByTestId('capture-toolbar-leading'), 'min-w-0', 'flex-1', 'overflow-hidden');
    expectClasses(screen.getByTestId('camera-selector'), 'relative', 'min-w-0', 'flex-1', 'shrink', 'overflow-hidden');
    expectClasses(screen.getByTestId('camera-selector-label'), 'min-w-0', 'flex-1', 'truncate');
    expectClasses(screen.getByTestId('camera-selector-select'), 'absolute', 'inset-0', 'w-full', 'opacity-0');

    expectClasses(screen.getByTestId('torch-control'), 'h-11', 'w-11', 'shrink-0');
    expectClasses(
      screen.getByTestId('torch-toggle'),
      'h-11',
      'w-11',
      'min-h-[44px]',
      'min-w-[44px]',
      'shrink-0',
      '!p-0',
    );
    expect(screen.getByTestId('torch-toggle').getAttribute('aria-pressed')).toBe('false');
  });
});
