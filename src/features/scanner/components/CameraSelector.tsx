/**
 * Lists available `videoinput` devices and lets the user switch the active
 * camera (design section 5.1 `devices`/`activeDeviceId`; scanner spec
 * "Multiples camaras disponibles"; proposal section 4.1 `CameraSelector.tsx`).
 *
 * Renders nothing when there is only one (or zero) camera — a picker is
 * noise when there is nothing to pick between.
 */

import type { ReactNode } from 'react';
import { Camera } from 'lucide-react';
import { useTranslation } from '@/shared/i18n';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface CameraSelectorProps {
  readonly onSelect: (deviceId: string) => void;
}

export function CameraSelector({ onSelect }: CameraSelectorProps): ReactNode {
  const { t } = useTranslation();
  const devices = useScannerStore((s) => s.devices);
  const activeDeviceId = useScannerStore((s) => s.activeDeviceId);

  if (devices.length < 2) {
    return null;
  }

  const activeDeviceIndex = devices.findIndex((device) => device.deviceId === activeDeviceId);
  const activeDevice = devices[activeDeviceIndex];
  const activeLabel =
    activeDevice?.label ||
    (activeDeviceIndex >= 0 ? t('camera.cameraN', { n: activeDeviceIndex + 1 }) : t('camera.selectCamera'));

  return (
    <label
      className="relative flex min-w-0 flex-1 shrink items-center gap-2 overflow-hidden rounded-lg bg-surface/80 px-3 py-2 text-sm text-text focus-within:ring-2 focus-within:ring-primary-light"
      data-testid="camera-selector"
    >
      <Camera size={18} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden="true" />
      <span className="sr-only">{t('camera.selectCamera')}</span>
      <span className="min-w-0 flex-1 truncate" data-testid="camera-selector-label" aria-hidden="true">
        {activeLabel}
      </span>
      <select
        value={activeDeviceId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        className="absolute inset-0 min-h-[44px] w-full cursor-pointer opacity-0 focus-visible:outline-none"
        data-testid="camera-selector-select"
      >
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId} className="bg-surface text-text">
            {device.label || t('camera.cameraN', { n: index + 1 })}
          </option>
        ))}
      </select>
    </label>
  );
}
