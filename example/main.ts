declare global {
  interface Window {
    app: { count: number };
  }
}

window.app = { count: 0 };
document.querySelector<HTMLDivElement>('#app')!.textContent =
  'Open the nREPL client and evaluate document.title or window.app.count.';

export {};
