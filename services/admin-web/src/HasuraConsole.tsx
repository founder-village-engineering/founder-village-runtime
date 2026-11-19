import React from "react";

export function HasuraConsole({ source }: { source: string }) {
  const url = `/hasura/console/data/manage/source/${encodeURIComponent(source)}`;
  return (
    <section className="hasura-panel">
      <div className="section-title">
        <div>
          <h2>Hasura console</h2>
          <p>Read-only inspection. Schema changes use versioned migrations.</p>
        </div>
        <a
          className="button secondary"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open full console ↗
        </a>
      </div>
      <p className="hasura-mobile-hint">
        Swipe sideways to explore the full console.
      </p>
      <div className="hasura-viewport">
        <iframe
          key={source}
          src={url}
          title="Hasura console"
          className="hasura-frame"
        />
      </div>
    </section>
  );
}
