import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { bootstrapSession } from './session';
import './index.css';

// Ask the server which identity this browser session owns before rendering. A brand new session
// discards the previous session's leftover queue/clock, so it always starts from an empty workspace.
void bootstrapSession().finally(() => createRoot(document.getElementById('root')!).render(<App />));
