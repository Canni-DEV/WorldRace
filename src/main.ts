import { App } from './app/App';
import './app/styles.css';

const rootElement = document.querySelector<HTMLDivElement>('#app');

if (rootElement === null) {
  throw new Error('Missing root #app element.');
}

const app = new App(rootElement);
app.start();

window.addEventListener('beforeunload', () => {
  app.destroy();
});
