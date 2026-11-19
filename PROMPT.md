> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

We are creating founder-village-runtime from scratch and using
/Users/zernach/code/archlife-apps-runtime as an example. This runtime should
include the necessities, such as:

- codified rust to build the VPS VM runtime
- deployment pipelines
- backup systems
- ultra high security
- postgres with pgvector
- hasura
- typescript api
- typescript admin panel (similar to the pyweb python-cloud admin panel, but in
  typescript) with cf cli (cloudflare cli) access to automate domain management
- queue
- wireguard profiles
- what else are we missing?
