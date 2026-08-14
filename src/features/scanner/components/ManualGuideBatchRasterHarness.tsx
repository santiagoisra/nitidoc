/**
 * Browser-only integration harness for the manual-guide raster contract.
 * It is mounted exclusively by `main.tsx`'s internal test route, leaving the
 * scanner UI and its production navigation untouched. Keeping this beside the
 * scanner code lets Playwright execute the real hook, resource helpers and
 * WorkerClient instead of duplicating their pixel pipeline in a test.
 */

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBatchProcess } from '@/features/scanner/hooks/useBatchProcess';
import { createWorkerClient } from '@/features/scanner/lib/workerClient';
import { paperSelection } from '@/features/scanner/lib/paperFormats';
import { scannerStoreInitialState, useScannerStore } from '@/features/scanner/store/scannerStore';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';
import type { RawCapture } from '@/features/scanner/store/documentSlice';

type RasterScenario = 'success' | 'degraded' | 'warp-failure';

function parseScenario(search: string): RasterScenario {
  const value = new URLSearchParams(search).get('scenario');
  return value === 'degraded' || value === 'warp-failure' ? value : 'success';
}

async function createSyntheticRawCapture(): Promise<RawCapture> {
  const canvas = new OffscreenCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ManualGuideBatchRasterHarness: failed to acquire synthetic canvas context.');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#00dc00';
  ctx.fillRect(20, 20, 60, 60);

  return {
    id: 'manual-guide-raster',
    order: 0,
    originalBlob: await canvas.convertToBlob({ type: 'image/png' }),
    thumbnail: canvas.transferToImageBitmap(),
    originalWidth: 100,
    originalHeight: 100,
    paper: paperSelection('a4', 'manual'),
    guideQuad: [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
      { x: 80, y: 80 },
      { x: 20, y: 80 },
    ],
  };
}

async function countResultColors(blob: Blob): Promise<{ outsideRedPixels: number; insideGreenPixels: number }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ManualGuideBatchRasterHarness: failed to read batch raster.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let outsideRedPixels = 0;
  let insideGreenPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index]!;
    const green = pixels[index + 1]!;
    if (red > 150 && green < 100) outsideRedPixels += 1;
    if (green > 150 && red < 100) insideGreenPixels += 1;
  }
  return { outsideRedPixels, insideGreenPixels };
}

export function ManualGuideBatchRasterHarness(): ReactNode {
  const scenario = parseScenario(window.location.search);
  const clientRef = useRef<WorkerClient | null>(null);
  const warpStateRef = useRef({ calls: 0, resolved: false, intentionalRejection: false });
  if (!clientRef.current) clientRef.current = createWorkerClient();
  const realClient = clientRef.current;
  const workerClient = useMemo<WorkerClient>(
    () => ({
      ...realClient,
      warp: async (...args: Parameters<WorkerClient['warp']>) => {
        warpStateRef.current.calls += 1;
        if (scenario === 'warp-failure') {
          warpStateRef.current.intentionalRejection = true;
          throw new Error('intentional browser WARP failure');
        }
        const response = await realClient.warp(...args);
        warpStateRef.current.resolved = true;
        return response;
      },
    }),
    [realClient, scenario],
  );
  const ensureOpenCvInit = useMemo(
    () => async () => {
      if (scenario === 'degraded') throw new Error('intentional browser OpenCV degradation');
      await realClient.init(() => undefined);
    },
    [realClient, scenario],
  );
  const { run } = useBatchProcess({ ensureOpenCvInit, workerClient });
  const [result, setResult] = useState<{ status: 'running' | 'complete' | 'error'; outsideRedPixels?: number; insideGreenPixels?: number; error?: string }>({ status: 'running' });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const raw = await createSyntheticRawCapture();
        useScannerStore.setState({ ...scannerStoreInitialState, phase: 'processing', rawCaptures: [raw] });
        const runResult = await run();
        const page = useScannerStore.getState().pages[0];
        if (!page || runResult.addedCount !== 1) throw new Error('Manual guide batch did not materialize one page.');
        const colors = await countResultColors(page.warpedBlob);
        if (active) setResult({ status: 'complete', ...colors });
      } catch (error) {
        if (active) setResult({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      active = false;
      realClient.terminate();
    };
  }, [realClient, run]);

  return (
    <output
      data-testid="manual-guide-raster-result"
      data-status={result.status}
      data-outside-red-pixels={result.outsideRedPixels}
      data-inside-green-pixels={result.insideGreenPixels}
      data-error={result.error}
      data-warp-calls={warpStateRef.current.calls}
      data-warp-resolved={String(warpStateRef.current.resolved)}
      data-warp-intentional-rejection={String(warpStateRef.current.intentionalRejection)}
    />
  );
}
