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
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface CameraSelectorProps {
  readonly onSelect: (deviceId: string) => void;
}

export function CameraSelector({ onSelect }: CameraSelectorProps): ReactNode {
  const devices = useScannerStore((s) => s.devices);
  const activeDeviceId = useScannerStore((s) => s.activeDeviceId);

  if (devices.length < 2) {
    return null;
  }

  return (
    <label className="flex items-center gap-2 rounded-lg bg-surface/80 px-3 py-2 text-sm text-text">
      <Camera size={18} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
      <span className="sr-only">Select camera</span>
      <select
        value={activeDeviceId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        className="min-h-[44px] flex-1 bg-transparent text-text focus-visible:outline-none"
      >
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId} className="bg-surface text-text">
            {device.label || `Camera ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
