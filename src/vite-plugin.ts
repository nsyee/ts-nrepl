import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createBrowserWebSocketServer } from './browser-bridge.ts';
import { createNReplServer } from './server.ts';
import { createServerContext } from './types.ts';

interface ViteDevServerLike {
  httpServer: import('node:http').Server | null;
  middlewares: {
    use(
      fn: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        next: () => void,
      ) => void,
    ): void;
  };
  config: { logger: { info(msg: string): void } };
}

export interface TsNreplPluginOptions {
  nreplPort?: number;
  wsPort?: number;
  wsHost?: string;
}

export interface TsNreplPlugin {
  name: string;
  apply: 'serve';
  configureServer(server: ViteDevServerLike): Promise<void>;
  transformIndexHtml(html: string): string;
}

const DEFAULT_NREPL_PORT = 7888;
const DEFAULT_WS_PORT = 7889;

export const tsNrepl = (options: TsNreplPluginOptions = {}): TsNreplPlugin => {
  const nreplPort = options.nreplPort ?? DEFAULT_NREPL_PORT;
  const wsPort = options.wsPort ?? DEFAULT_WS_PORT;
  const wsHost = options.wsHost ?? 'localhost';

  return {
    name: 'ts-nrepl',
    apply: 'serve',
    async configureServer(server): Promise<void> {
      const context = createServerContext('browser');
      const nrepl = createNReplServer(context);
      await new Promise<void>((resolve, reject) => {
        nrepl.server.once('error', reject);
        nrepl.server.listen(nreplPort, resolve);
      });
      const webSocket = await createBrowserWebSocketServer(context.browser, wsPort);
      server.config.logger.info(`nREPL TS server listening on port ${nreplPort}`);
      server.config.logger.info(`browser WebSocket listening on port ${wsPort}`);

      const clientPath = new URL('./browser-client.ts', import.meta.url);
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/@ts-nrepl/browser-client.js') {
          next();
          return;
        }
        void readFile(clientPath, 'utf8')
          .then((source) => {
            const client = stripTypeScriptTypes(source, { mode: 'strip' });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/javascript');
            response.end(client);
          })
          .catch(next);
      });

      server.httpServer?.on('close', () => {
        nrepl.server.close();
        webSocket.close();
      });
    },
    transformIndexHtml(html): string {
      const scripts =
        `<script>window.__TS_NREPL__={wsUrl:"ws://${wsHost}:${wsPort}/nrepl"}</script>` +
        '<script type="module" src="/@ts-nrepl/browser-client.js"></script>';
      const head = '</head>';
      return html.includes(head) ? html.replace(head, `${scripts}${head}`) : `${html}${scripts}`;
    },
  };
};
