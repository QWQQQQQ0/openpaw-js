import React from 'react';
import ReactDOM from 'react-dom/client';
import { enableMapSet } from 'immer';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './index.css';

enableMapSet();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
