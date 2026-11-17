import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/popup/App';
import '../../src/popup/popup.css';

createRoot(document.getElementById('root')!).render(<App />);
