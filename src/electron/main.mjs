import { startApp } from './app.mjs';
import { app } from 'electron';
startApp().catch(error => { console.error(error); app.exit(1); });
