import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardDismiss } from "./useKeyboardDismiss.ts";
import "./style.css";
type Row = Record<string, unknown>;
type Snapshot = {
  applications: { id: string; database: string; hasuraSource: string }[];
  environment: string;
  revision: string;
  actor: string;
  actions: string[];
  operations: Row[];
  audit: Row[];
  backups: Row[];
  deployments: Row[];
  peers: Row[];
  administrators: Row[];
};
const pages = [
  "Overview",
  "Databases",
  "Deployments",
  "Backups",
  "Operations",
  "Domains",
  "Access",
  "Audit",
] as const;
type Page = (typeof pages)[number];
const format = (s: unknown) => (s == null ? "—" : String(s));
const date = (s: unknown) => (s ? new Date(String(s)).toLocaleString() : "—");
async function request<T>(url: string, body?: unknown): Promise<T> {
  const csrf =
    document.cookie
      .split("; ")
      .find((s) => s.startsWith("fv_csrf="))
      ?.split("=")[1] ?? "";
  const res = await fetch(url, {
    credentials: "same-origin",
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "x-csrf-token": csrf,
            "idempotency-key": crypto.randomUUID(),
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to continue.");
    if (res.status === 403)
      throw new Error("Your account does not have permission for this action.");
    throw new Error(`The request could not be completed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}
function Pill({ value }: { value: unknown }) {
  const s = format(value);
  return (
    <span
      className={`pill ${["succeeded", "serving", "ready", "completed", "true"].includes(s) ? "good" : ["failed", "dead", "false"].includes(s) ? "bad" : ""}`}
    >
      {s}
    </span>
  );
}
function Table({
  rows,
  columns,
  empty = "No activity yet.",
}: {
  rows: Row[];
  columns: [string, string][];
  empty?: string;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={format(r.id ?? r.name ?? r.actor ?? i)}>
              {columns.map(([key]) => (
                <td key={key}>
                  {[
                    "state",
                    "outcome",
                    "enabled",
                    "verified",
                    "offsite",
                  ].includes(key) ? (
                    <Pill value={r[key]} />
                  ) : key.endsWith("_at") ? (
                    date(r[key])
                  ) : (
                    <span
                      className={
                        ["id", "revision", "hash"].includes(key) ? "mono" : ""
                      }
                    >
                      {Array.isArray(r[key])
                        ? (r[key] as string[]).join(", ")
                        : format(r[key])}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <span>◌</span>
      <p>{empty}</p>
    </div>
  );
}
function App() {
  useKeyboardDismiss();
  const [page, setPage] = useState<Page>("Overview"),
    [selectedApplication, setSelectedApplication] = useState("founder-village"),
    [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [local, setLocal] = useState(false),
    [review, setReview] = useState<{ action: string; parameters: Row } | null>(
      null,
    ),
    [dnsPlan, setDnsPlan] = useState<Row | null>(null);
  useEffect(() => {
    if (!review) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const buttons = dialog?.querySelectorAll<HTMLElement>("button");
    buttons?.[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setReview(null);
      if (e.key === "Tab" && buttons?.length) {
        const first = buttons[0]!,
          last = buttons[buttons.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [review, busy]);
  useEffect(() => {
    if (data && !data.applications.some((a) => a.id === selectedApplication))
      setSelectedApplication(data.applications[0]?.id ?? "");
  }, [data, selectedApplication]);
  const refresh = async () => {
    try {
      setData(await request<Snapshot>("/api/dashboard"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void request<{ local: boolean }>("/auth/status").then((r) =>
      setLocal(r.local),
    );
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
      setNotice(message);
      setError("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (
    event: React.FormEvent<HTMLFormElement>,
    fn: (f: FormData) => void,
  ) => {
    event.preventDefault();
    fn(new FormData(event.currentTarget));
  };
  const permitted = (action: string) => data?.actions.includes(action) ?? false;
  const queue = (action: string, parameters: Row = {}) =>
    setReview({ action, parameters });
  if (!data)
    return (
      <main className="login">
        <div className="mark">
          fv<span>•</span>
        </div>
        <div className="eyebrow">FOUNDER VILLAGE</div>
        <h1>
          Your village,
          <br />
          in good hands.
        </h1>
        <p>Secure access to infrastructure, releases, and recovery.</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {local ? (
          <button
            disabled={busy}
            onClick={() =>
              void perform(
                () => request("/auth/local", {}),
                "Signed in to the local environment.",
              )
            }
          >
            Open local console <span>↗</span>
          </button>
        ) : (
          <a className="button" href="/auth/login">
            Sign in securely ↗
          </a>
        )}
        <small>
          {local
            ? "Synthetic local administrator · development only"
            : "Administrator access requires MFA and an explicit grant."}
        </small>
      </main>
    );
  const pending = data.operations.filter((r) =>
    ["queued", "running", "awaiting_authorization"].includes(format(r.state)),
  ).length;
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/" aria-label="Founder Village home">
          <div className="mark">
            fv<span>•</span>
          </div>
          <div>
            Founder Village<small>RUNTIME CONSOLE</small>
          </div>
        </a>
        <div className="workspace">
          <span className="dot" />
          {data.environment}
          <span className="workspace-tag">ENV</span>
        </div>
        <nav aria-label="Main navigation">
          {pages.map((p, i) => (
            <button
              key={p}
              className={page === p ? "selected" : ""}
              onClick={() => setPage(p)}
            >
              <span aria-hidden="true">
                {["◫", "▦", "↗", "▤", "⇄", "◎", "♧", "≡"][i]}
              </span>
              {p}
              {p === "Operations" && pending > 0 && <b>{pending}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="dot" /> Control plane connected
          <small>Changes are scoped to {data.environment}.</small>
          <button
            onClick={() =>
              void perform(async () => {
                await request("/auth/logout", {});
                setData(null);
              }, "Signed out.")
            }
          >
            Sign out ↗
          </button>
        </div>
      </aside>
      <div className="main">
        <header>
          <span>
            Infrastructure / <strong>{page}</strong>
          </span>
          <select
            className="application-picker"
            aria-label="Application namespace"
            value={selectedApplication}
            onChange={(e) => setSelectedApplication(e.target.value)}
          >
            {data.applications.map((a) => (
              <option key={a.id}>{a.id}</option>
            ))}
          </select>
          <span className="identity" title={data.actor}>
            ● {data.actor.split("|").at(-1)}
          </span>
        </header>
        <main>
          <div className="page-heading">
            <div className="eyebrow">YOUR VILLAGE, RUNNING WELL</div>
            <div className="heading-row">
              <div>
                <h1>
                  {page === "Overview" ? "A clear view of everything." : page}
                </h1>
                <p>
                  {
                    {
                      Overview:
                        "Infrastructure and recent activity, in one place.",
                      Databases:
                        "Separate databases and Hasura sources for every part of the village.",
                      Deployments:
                        "Promote a verified release. Keep a safe path back.",
                      Backups: "Recovery starts with evidence you can trust.",
                      Operations: "Durable work, with an accountable owner.",
                      Domains: "Review DNS changes before applying them.",
                      Access: "Named people. Explicit permissions.",
                      Audit: "A permanent record of administrative activity.",
                    }[page]
                  }
                </p>
              </div>
              <button className="secondary" onClick={() => void refresh()}>
                ↻ Refresh
              </button>
            </div>
          </div>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {page === "Overview" && (
            <>
              <div className="metrics">
                <article>
                  <span>Environment</span>
                  <strong>{data.environment}</strong>
                  <small>Isolated runtime boundary</small>
                </article>
                <article>
                  <span>Active operations</span>
                  <strong>{pending.toString().padStart(2, "0")}</strong>
                  <small>
                    {data.operations.filter((r) => r.state === "failed").length}{" "}
                    require attention
                  </small>
                </article>
                <article>
                  <span>Recovery snapshots</span>
                  <strong>
                    {data.backups.length.toString().padStart(2, "0")}
                  </strong>
                  <small>Verification and offsite status below</small>
                </article>
                <article>
                  <span>Release</span>
                  <strong className="mono">{data.revision.slice(0, 8)}</strong>
                  <small>Serving application revision</small>
                </article>
              </div>
              <div className="two-column">
                <section>
                  <div className="section-title">
                    <h2>Recent operations</h2>
                    <button
                      className="text"
                      onClick={() => setPage("Operations")}
                    >
                      View all ↗
                    </button>
                  </div>
                  <Table
                    rows={data.operations.slice(0, 6)}
                    columns={[
                      ["action", "Action"],
                      ["state", "Status"],
                      ["created_at", "Started"],
                    ]}
                  />
                </section>
                <section className="recovery-card">
                  <div className="round-icon">↺</div>
                  <div className="eyebrow">BUILT FOR RECOVERY</div>
                  <h2>
                    A backup is a beginning.
                    <br />A tested restore is confidence.
                  </h2>
                  <p>
                    Track encrypted snapshots, offsite copies, and isolated
                    restore drills.
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setPage("Backups")}
                  >
                    Review recovery →
                  </button>
                </section>
              </div>
              <section>
                <h2>Recent audit activity</h2>
                <Table
                  rows={data.audit.slice(0, 5)}
                  columns={[
                    ["event", "Event"],
                    ["outcome", "Outcome"],
                    ["created_at", "Time"],
                  ]}
                />
              </section>
            </>
          )}
          {page === "Databases" && (
            <section>
              <h2>Application namespaces</h2>
              <p>
                Each application has its own PostgreSQL database, migration
                role, API role, worker role, and Hasura source. Backups cover
                the complete environment cluster.
              </p>
              <Table
                rows={data.applications}
                columns={[
                  ["id", "Application"],
                  ["database", "PostgreSQL database"],
                  ["hasuraSource", "Hasura source"],
                ]}
              />
              <p>
                Internal control and Hasura metadata databases are kept separate
                from these application databases.
              </p>
            </section>
          )}
          {page === "Deployments" && (
            <>
              <section>
                <h2>Promote a release</h2>
                <p>
                  Use a prepared, signed release ID from the CLI. Candidate
                  checks run before traffic moves.
                </p>
                <form
                  onSubmit={(e) =>
                    submit(e, (f) =>
                      queue("deploy.release", { release: f.get("release") }),
                    )
                  }
                >
                  <label>
                    Release ID
                    <input
                      required
                      name="release"
                      pattern="[a-f0-9]{64}"
                      placeholder="64-character release fingerprint"
                    />
                  </label>
                  <button disabled={busy || !permitted("deploy.release")}>
                    Review deployment →
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!permitted("deploy.rollback")}
                    onClick={() => queue("deploy.rollback")}
                  >
                    Review rollback
                  </button>
                </form>
              </section>
              <section>
                <h2>Release history</h2>
                <Table
                  rows={data.deployments}
                  columns={[
                    ["revision", "Revision"],
                    ["color", "Color"],
                    ["state", "Status"],
                    ["created_at", "Time"],
                  ]}
                />
              </section>
            </>
          )}
          {page === "Backups" && (
            <>
              <div className="metrics">
                <article>
                  <span>Database recovery point target</span>
                  <strong>5 min</strong>
                  <small>Validate against actual WAL archiving</small>
                </article>
                <article>
                  <span>Full recovery time target</span>
                  <strong>4 hours</strong>
                  <small>Measured by a clean-target drill</small>
                </article>
              </div>
              <section>
                <h2>Recovery actions</h2>
                <p>
                  Restore drills use a new, isolated target. Production data
                  stays in place.
                </p>
                <div className="actions">
                  {[
                    ["backup.capture", "Capture full backup", { type: "full" }],
                    ["backup.verify", "Verify backup", {}],
                    ["backup.restore-drill", "Run isolated restore", {}],
                  ].map(([action, label, params]) => (
                    <button
                      key={String(action)}
                      disabled={!permitted(String(action))}
                      onClick={() => queue(String(action), params as Row)}
                    >
                      {String(label)}
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h2>Snapshot evidence</h2>
                <Table
                  rows={data.backups}
                  columns={[
                    ["created_at", "Captured"],
                    ["verified", "Verified"],
                    ["offsite", "Offsite"],
                    ["restored", "Restored"],
                  ]}
                  empty="No backup receipts yet. Capture and verify a snapshot to establish recovery evidence."
                />
              </section>
            </>
          )}
          {page === "Operations" && (
            <section>
              <h2>Operation ledger</h2>
              {data.operations
                .filter(
                  (r) =>
                    r.state === "awaiting_authorization" &&
                    r.actor === data.actor,
                )
                .map((r) => (
                  <p key={String(r.id)}>
                    <a href={`/auth/authorize/${r.id}`}>
                      Complete MFA authorization for {String(r.action)} →
                    </a>
                  </p>
                ))}
              <Table
                rows={data.operations}
                columns={[
                  ["action", "Action"],
                  ["state", "Status"],
                  ["actor", "Requested by"],
                  ["updated_at", "Updated"],
                ]}
              />
              <form
                onSubmit={(e) =>
                  submit(
                    e,
                    (f) =>
                      void perform(
                        () =>
                          request(
                            `/api/operations/${f.get("operation")}/cancel`,
                            {},
                          ),
                        "Queued operation cancelled.",
                      ),
                  )
                }
              >
                <label>
                  Cancel a queued operation
                  <input
                    name="operation"
                    required
                    placeholder="Operation UUID"
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  Cancel operation
                </button>
              </form>
              <form
                onSubmit={(e) =>
                  submit(e, (f) =>
                    queue("jobs.retry", {
                      application: selectedApplication,
                      jobId: f.get("job"),
                    }),
                  )
                }
              >
                <label>
                  Retry a dead job
                  <input required name="job" placeholder="Job UUID" />
                </label>
                <button disabled={!permitted("jobs.retry")}>
                  Review retry →
                </button>
              </form>
            </section>
          )}
          {page === "Domains" && (
            <>
              <section>
                <h2>Plan a DNS change</h2>
                <p>
                  Only configured names in the approved zone can be managed.
                  Plans expire after ten minutes.
                </p>
                <form
                  onSubmit={(e) =>
                    submit(
                      e,
                      (f) =>
                        void perform(async () => {
                          const name = String(f.get("name"));
                          const desired = f.get("delete")
                            ? null
                            : {
                                name,
                                type: f.get("type"),
                                content: f.get("content"),
                                ttl: 300,
                                proxied: f.get("proxied") === "on",
                              };
                          setDnsPlan(
                            await request("/api/dns/plan", { name, desired }),
                          );
                        }, "DNS plan ready for review."),
                    )
                  }
                >
                  <label>
                    Record name
                    <input name="name" required placeholder="api.example.com" />
                  </label>
                  <label>
                    Type
                    <select name="type">
                      {["A", "AAAA", "CNAME", "TXT"].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Value
                    <input name="content" placeholder="Record content" />
                  </label>
                  <label className="check">
                    <input type="checkbox" name="proxied" /> Proxy through
                    Cloudflare
                  </label>
                  <label className="check">
                    <input type="checkbox" name="delete" /> Delete this managed
                    record
                  </label>
                  <button disabled={!permitted("dns.plan") || busy}>
                    Generate plan →
                  </button>
                </form>
              </section>
              {dnsPlan && (
                <section>
                  <h2>Change preview</h2>
                  <pre>
                    {JSON.stringify(
                      { before: dnsPlan.before, after: dnsPlan.desired },
                      null,
                      2,
                    )}
                  </pre>
                  <button
                    disabled={!permitted("dns.apply")}
                    onClick={() => queue("dns.apply", { planId: dnsPlan.id })}
                  >
                    Review and apply →
                  </button>
                </section>
              )}
            </>
          )}
          {page === "Access" && (
            <>
              <section>
                <h2>Console administrators</h2>
                <Table
                  rows={data.administrators}
                  columns={[
                    ["actor", "Identity"],
                    ["actions", "Explicit grants"],
                    ["enabled", "Enabled"],
                  ]}
                />
                {permitted("admins.manage") && (
                  <form
                    onSubmit={(e) =>
                      submit(
                        e,
                        (f) =>
                          void perform(
                            () =>
                              request("/api/admins", {
                                actor: f.get("actor"),
                                actions: String(f.get("actions"))
                                  .split(",")
                                  .map((x) => x.trim()),
                                enabled: f.get("enabled") === "on",
                                applications: String(f.get("applications"))
                                  .split(",")
                                  .map((x) => x.trim()),
                              }),
                            "Administrator access updated. Existing sessions revoked.",
                          ),
                      )
                    }
                  >
                    <label>
                      Verified issuer and subject
                      <input
                        required
                        name="actor"
                        placeholder="https://identity.example.com|subject"
                      />
                    </label>
                    <label>
                      Comma-separated action grants
                      <input
                        name="actions"
                        required
                        defaultValue="dashboard.read"
                      />
                    </label>
                    <label>
                      Application grants
                      <input
                        name="applications"
                        required
                        defaultValue={selectedApplication}
                      />
                    </label>
                    <label className="check">
                      <input type="checkbox" name="enabled" defaultChecked />{" "}
                      Enabled
                    </label>
                    <button disabled={busy}>Update access</button>
                  </form>
                )}
              </section>
              <section>
                <h2>WireGuard devices</h2>
                <p>
                  Enroll each device public key with the CLI. Private keys stay
                  on the device.
                </p>
                <Table
                  rows={data.peers}
                  columns={[
                    ["name", "Device"],
                    ["address", "Address"],
                    ["enabled", "Enabled"],
                    ["expires_at", "Expires"],
                  ]}
                />
                <form
                  onSubmit={(e) =>
                    submit(e, (f) =>
                      queue("wireguard.revoke", { name: f.get("name") }),
                    )
                  }
                >
                  <label>
                    Device to revoke
                    <input required name="name" pattern="[a-z0-9-]+" />
                  </label>
                  <button disabled={!permitted("wireguard.revoke")}>
                    Review revocation →
                  </button>
                </form>
              </section>
            </>
          )}
          {page === "Audit" && (
            <section>
              <div className="section-title">
                <h2>Administrative history</h2>
                <button
                  className="secondary"
                  disabled={!permitted("audit.archive")}
                  onClick={() => queue("audit.archive")}
                >
                  Archive checkpoint
                </button>
              </div>
              <Table
                rows={data.audit}
                columns={[
                  ["event", "Event"],
                  ["actor", "Actor"],
                  ["outcome", "Outcome"],
                  ["created_at", "Time"],
                  ["hash", "Integrity hash"],
                ]}
              />
            </section>
          )}
          {page === "Operations" && (
            <section>
              <h2>Durable schedules</h2>
              <p>
                Schedules belong to the selected application and use a leased
                scheduler. Missed intervals coalesce into one run.
              </p>
              <form
                onSubmit={(e) =>
                  submit(e, (f) =>
                    queue("schedules.manage", {
                      application: selectedApplication,
                      name: f.get("name"),
                      intervalSeconds: Number(f.get("seconds")),
                    }),
                  )
                }
              >
                <label>
                  Schedule name
                  <input required name="name" pattern="[a-z0-9-]+" />
                </label>
                <label>
                  Interval in seconds
                  <input
                    type="number"
                    required
                    name="seconds"
                    min="60"
                    max="2592000"
                    defaultValue="3600"
                  />
                </label>
                <button disabled={!permitted("schedules.manage")}>
                  Review schedule →
                </button>
              </form>
            </section>
          )}
          <footer>
            Founder Village Runtime{" "}
            <span>Private by design. Verifiable in operation.</span>
          </footer>
        </main>
      </div>
      {review && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
          >
            <div className="eyebrow">REVIEW OPERATION</div>
            <h2 id="review-title">{review.action}</h2>
            <p>
              This action will run in <strong>{data.environment}</strong> as{" "}
              <strong>{data.actor.split("|").at(-1)}</strong>.
            </p>
            <pre>{JSON.stringify(review.parameters, null, 2)}</pre>
            <p>
              Authorization and current state are checked again when execution
              begins.
            </p>
            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = await request<{ id: string; state: string }>(
                      "/api/operations",
                      review,
                    );
                    if (result.state === "awaiting_authorization") {
                      window.location.assign(`/auth/authorize/${result.id}`);
                      return;
                    }
                    setReview(null);
                    setPage("Operations");
                  }, "Operation queued. Follow its durable status below.")
                }
              >
                {busy ? "Submitting…" : "Confirm operation →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
