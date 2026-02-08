import { buildApp } from "./server.js";
import { loadRuntimeConfig } from "./infra/config.js";

const config = loadRuntimeConfig();
const app = buildApp(config);

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    console.log(`PMC reference API listening on http://${config.host}:${config.port}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
