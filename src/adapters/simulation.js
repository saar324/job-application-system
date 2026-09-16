export class SimulationAdapter {
  name = "simulation";
  async submit({ application, opportunity }) {
    return {
      externalId: `sim-${application.id}`,
      submittedAt: new Date().toISOString(),
      source: opportunity.source,
      simulated: true
    };
  }
}
