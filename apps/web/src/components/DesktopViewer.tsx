import type { VmStatus } from '../types';
import { Icon } from './Icon';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

type DesktopViewerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screenshot: string | null;
  vm: VmStatus | null;
};

export function DesktopViewer({ open, onOpenChange, screenshot, vm }: DesktopViewerProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-6xl gap-5 bg-[#0b0d10] p-3 sm:p-5">
        <DialogHeader className="px-1 pt-1">
          <DialogTitle>Helm desktop</DialogTitle>
          <DialogDescription>Latest screenshot from the controlled environment.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[240px] items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-black sm:min-h-[420px]">
          {screenshot ? (
            <img alt="Latest Linux guest desktop screenshot" className="max-h-[70vh] w-full object-contain" src={screenshot} />
          ) : (
            <div className="flex flex-col items-center gap-3 text-sm text-[#606975]">
              <Icon name="monitor" size={24} />
              <span>No desktop screenshot yet.</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-1 text-xs text-[#79838f]">
          <span className={`size-1.5 rounded-full ${vm?.guestConnected ? 'bg-emerald-400' : 'bg-[#606975]'}`} />
          <span>{vm?.guestConnected ? 'Guest connected' : 'Guest not connected'}</span>
          <span className="text-[#4f5863]">·</span>
          <span>Screenshot preview</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
