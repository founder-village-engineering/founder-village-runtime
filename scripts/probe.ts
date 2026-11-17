import { connect } from "node:tls";
const endpoint = new URL(process.env.PUBLIC_API_URL ?? "");
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
  throw new Error("public HTTPS endpoint required");
const response = await fetch(new URL("/health/ready", endpoint), {
  signal: AbortSignal.timeout(10000),
  redirect: "error",
});
if (!response.ok) throw new Error("external_readiness_failed");
await new Promise<void>((resolve, reject) => {
  const socket = connect(
    {
      host: endpoint.hostname,
      port: 443,
      servername: endpoint.hostname,
      rejectUnauthorized: true,
    },
    () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (Date.parse(cert.valid_to) - Date.now() < 7 * 86400000)
        reject(new Error("certificate_expiring"));
      else resolve();
    },
  );
  socket.setTimeout(10000, () => {
    socket.destroy();
    reject(new Error("TLS probe timed out"));
  });
  socket.once("error", () => reject(new Error("TLS probe failed")));
});
console.log(
  JSON.stringify({
    event: "external_probe.passed",
    timestamp: new Date().toISOString(),
  }),
);
