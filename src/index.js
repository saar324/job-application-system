import { createAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { SimulationAdapter } from "./adapters/simulation.js";
import { WebhookAdapter } from "./adapters/webhook.js";
import { ApplicationService } from "./service.js";
import { initializeStore } from "./storage.js";
import { ProfileStore } from "./profile-store.js";
import { DiscoveryService } from "./discovery/service.js";
import { documentStagerFromEnv } from "./documents.js";
import { credentialVaultFromEnv } from "./credential-vault.js";
import { semanticEnricherFromEnv } from "./discovery/enrichment.js";

const config = await loadConfig();
const store = await initializeStore();
const profiles = await new ProfileStore(
  process.env.JOB_SERVER_PROFILES_FILE ?? "./config/profiles.json",
  { allowMissing: true }
).init();
const adapter = config.execution.adapter === "webhook"
  ? new WebhookAdapter({ url: process.env.APPLICATION_WEBHOOK_URL, token: process.env.APPLICATION_WEBHOOK_TOKEN })
  : new SimulationAdapter();
const documentStager = config.execution.adapter === "webhook" ? documentStagerFromEnv() : undefined;
const credentialVault = await credentialVaultFromEnv();
const service = new ApplicationService({ store, config, adapter, profiles, documentStager, credentialVault });
await service.recover();
const discovery = new DiscoveryService({
  applicationService: service, profiles, config, enricher: semanticEnricherFromEnv()
});
const server = createHttpServer({ service, discovery, profiles, authenticate: createAuthenticator(), config });
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4310);
server.listen(port, host, () => {
  console.log(`job-application-server listening on http://${host}:${port} (${adapter.name})`);
});
