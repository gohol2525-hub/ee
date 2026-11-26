export type AdvancedToolId = 'ocr' | 'compression' | 'password' | 'stamps' | 'forms';

/** Tool panels are wrapped in the application's shared modal. Pages are zero-based. */
export interface DocumentToolProps {
  name: string;
  pageCount: number;
  activePage: number;
  locked?: boolean;
  getBytes: () => Promise<Uint8Array>;
  onApply: (bytes: Uint8Array, name?: string) => Promise<void>;
  onDownload: (bytes: Uint8Array, name: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}
