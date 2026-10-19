// Runs rotem-hub inside `astro dev`, on the dev server's own port, so one URL gives live reload
// and the board. Production uses server/hub.mjs standalone.
//
// Astro restarts its dev server (config edits, dependency re-optimisation) without always calling
// astro:server:done, so exactly one hub is kept per process and re-attached to each new server.
import { createHub } from "./hub.mjs";

const KEY = Symbol.for("rotem-hub.dev");

export default function rotemHub() {
  return {
    name: "rotem-hub",
    hooks: {
      "astro:server:setup": ({ server, logger }) => {
        if (!server.httpServer) return;
        const prev = globalThis[KEY];
        if (prev?.server === server.httpServer) return;
        prev?.hub.close();
        const hub = createHub(server.httpServer, {
          log: (m) => logger.info(m),
        });
        globalThis[KEY] = { hub, server: server.httpServer };
        server.middlewares.use((req, res, next) =>
          globalThis[KEY].hub.middleware(req, res, next),
        );
      },
      "astro:server:done": () => {
        globalThis[KEY]?.hub.close();
        globalThis[KEY] = undefined;
      },
    },
  };
}
