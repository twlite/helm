import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import Application from './application';
import { TooltipProvider } from '@/components/ui/tooltip';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Application />
    </TooltipProvider>
  </StrictMode>,
);
