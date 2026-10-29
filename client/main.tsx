import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/room.css';

const root = document.getElementById('root');
if (!root) throw new Error('React root is missing');
createRoot(root).render(<App />);
