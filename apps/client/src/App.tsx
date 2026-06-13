import { BrowserRouter, Routes, Route } from 'react-router';
import Index from './routes';
import ConversationRoute from './routes/conversation';
import MemoriesRoute from './routes/memories';
import NotFound from './routes/not-found';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/conversations/:conversationId" element={<ConversationRoute />} />
        <Route path="/memories" element={<MemoriesRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
