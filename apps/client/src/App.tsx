import { BrowserRouter, Routes, Route } from 'react-router';
import Index from './routes';
import NotFound from './routes/not-found';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
