import './style.css';
import { App } from './app';

const app = new App();
void app.start();
// handy for poking at things from the devtools console
(window as unknown as { app: App }).app = app;
