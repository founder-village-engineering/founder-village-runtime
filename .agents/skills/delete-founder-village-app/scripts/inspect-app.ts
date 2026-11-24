import { parseArgs } from "node:util";

function readTarget() {
  try {
    const { values, tokens } = parseArgs({
      options: {
        frontend: { type: "string" },
        application: { type: "string" },
      },
      tokens: true,
    });
    if (tokens.length === 1) {
      if (values.frontend)
        return { kind: "frontend", id: values.frontend } as const;
      if (values.application)
        return { kind: "application", id: values.application } as const;
    }
  } catch {
    // Keep raw arguments out of diagnostics.
  }
  console.error(
    "Choose exactly one selector: --frontend <slug> or --application <application-id>.",
  );
}

async function main(): Promise<void> {
  const target = readTarget();
  if (!target) {
    process.exitCode = 2;
    return;
  }

  try {
    const { applications } =
      await import("../../../../packages/database/applications.ts");
    const { frontends, featureFrontends } =
      await import("../../../../packages/frontends/index.ts");
    const frontend =
      target.kind === "frontend"
        ? frontends.find((entry) => entry.id === target.id)
        : undefined;
    const applicationId =
      target.kind === "frontend" ? frontend?.application : target.id;
    const application = applications.find(
      (entry) => entry.id === applicationId,
    );
    if (!application) {
      console.error(
        `No exact ${target.kind} registration. Check the pre-removal inventory if the registry was already edited.`,
      );
      process.exitCode = 1;
      return;
    }

    const namespaceConsumers = frontends.flatMap((entry) => {
      const primaryApplication = entry.application === application.id;
      const throughFeatures = featureFrontends(entry)
        .filter((feature) => feature.application === application.id)
        .map((feature) => feature.id);
      return primaryApplication || throughFeatures.length
        ? [{ frontend: entry.id, primaryApplication, throughFeatures }]
        : [];
    });

    const inventory = {
      target,
      frontendRegistration: frontend,
      featureApplications:
        frontend &&
        featureFrontends(frontend).map((feature) => ({
          frontend: feature.id,
          application: feature.application,
        })),
      composedFrontendConsumers:
        frontend &&
        frontends
          .filter((entry) =>
            entry.featureFrontends?.some((id) => id === frontend.id),
          )
          .map((entry) => entry.id),
      namespace: {
        id: application.id,
        database: application.database,
        hasuraSource: application.hasuraSource,
        migrations: `database/applications/${application.id}/`,
        hasuraTables: `hasura/applications/${application.id}/tables.json`,
      },
      namespaceConsumers,
    };
    console.log(JSON.stringify(inventory, null, 2));
  } catch {
    console.error(
      "Could not load the runtime registries. Validate config/frontends.json and config/applications.json locally.",
    );
    process.exitCode = 1;
  }
}

await main();
