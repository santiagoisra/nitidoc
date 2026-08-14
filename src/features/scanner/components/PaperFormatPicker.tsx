import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import { useTranslation } from '@/shared/i18n';
import { CAPTURE_PAPER_FORMAT_OPTIONS } from '@/features/scanner/lib/paperFormats';
import type { PaperFormatAlias } from '@/shared/types/paper';

export interface PaperFormatPickerProps {
  readonly value: PaperFormatAlias;
  readonly onChange: (alias: PaperFormatAlias) => void;
  readonly testId?: string;
}

/** Shared pre-capture/import paper selection with roving radio keyboard support. */
export function PaperFormatPicker({ value, onChange, testId = 'capture-paper-format' }: PaperFormatPickerProps): ReactNode {
  const { t } = useTranslation();
  const optionRefs = useRef<Partial<Record<PaperFormatAlias, HTMLButtonElement | null>>>({});
  const labels: Record<PaperFormatAlias, string> = {
    a4: t('capture.paperA4A3'),
    oficio: t('capture.paperOficio'),
    letter: t('capture.paperLetter'),
    legal: t('capture.paperLegal'),
    ticket: t('capture.paperTicket'),
    original: t('capture.paperOriginal'),
  };
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = CAPTURE_PAPER_FORMAT_OPTIONS.indexOf(value);
      const nextIndex =
        event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (currentIndex - 1 + CAPTURE_PAPER_FORMAT_OPTIONS.length) % CAPTURE_PAPER_FORMAT_OPTIONS.length
          : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? (currentIndex + 1) % CAPTURE_PAPER_FORMAT_OPTIONS.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? CAPTURE_PAPER_FORMAT_OPTIONS.length - 1
                : null;
      if (nextIndex === null) return;
      event.preventDefault();
      const nextAlias = CAPTURE_PAPER_FORMAT_OPTIONS[nextIndex];
      if (!nextAlias) return;
      onChange(nextAlias);
      optionRefs.current[nextAlias]?.focus();
    },
    [onChange, value],
  );

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <span className="text-sm font-semibold text-white">{t('capture.paperFormat')}</span>
      <div role="radiogroup" aria-label={t('capture.paperFormat')} className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {CAPTURE_PAPER_FORMAT_OPTIONS.map((alias) => {
          const selected = alias === value;
          return (
            <button
              key={alias}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              ref={(element) => {
                optionRefs.current[alias] = element;
              }}
              onClick={() => onChange(alias)}
              onKeyDown={handleKeyDown}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
                selected ? 'bg-primary text-[#0f0e0c]' : 'bg-black/45 text-white hover:bg-black/65'
              }`}
            >
              {labels[alias]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
