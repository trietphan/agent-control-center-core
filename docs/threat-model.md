# Threat model

This document covers the public local control plane, built-in and third-party adapters, local evidence, and the optional outbound ACCP execution node. It does not claim to cover a managed multi-tenant service, because no such service is shipped in this repository.

## Security objectives

1. Only the intended local operator can mutate the control plane.
2. A task cannot silently escape its state machine, route, review gate, or evidence record.
3. A crashed worker does not leave an untracked process or automatically duplicate an ambiguous external side effect.
4. ACCP messages are authenticated, integrity protected, scoped to a workspace and session, and replayed idempotently.
5. Artifacts and credentials remain confined to the intended local account and paths.
6. Invalid, newer, or corrupted durable state fails closed.

## Assets

- source repositories, worktrees, uncommitted changes, and Git credentials;
- agent-provider credentials available to Codex, Claude, or OpenClaw;
- task prompts, messages, success criteria, model output, diffs, test logs, and screenshots;
- the local daemon bearer token;
- the ACCP node private key, node credentials, controller public key, and enrollment code;
- task, review, lease, effect-grant, idempotency, cursor, and audit state;
- external systems an adapter is allowed to modify.

## Trust boundaries and assumptions

The default local trust boundary is one operating-system user account. Anyone who can read that account's files, attach to its processes, replace executables on `PATH`, or alter its repositories can generally act with the same authority as ACC.

The following components are trusted to different degrees:

- The coordinator, database layer, artifact store, router, and verifier are trusted enforcement code.
- Agent CLIs and third-party adapters are trusted execution extensions but their output is untrusted evidence. They run as the same OS user and are not plugin-sandboxed.
- Repository contents, task text, fetched plans, agent responses, and external API responses are untrusted input.
- The loopback network is not treated as an authentication boundary; the bearer token is still mandatory.
- A remote ACCP controller is trusted to schedule work only after enrollment. Signatures authenticate it; they do not make a compromised controller safe.

## Threats, controls, and residual risk

| Threat | Existing controls | Residual risk and operator action |
| --- | --- | --- |
| A local website or process calls the daemon | Loopback-only bind, bearer auth, allowed Host header set, explicit CORS allowlist, no-store responses, constant-time token comparison | Malware running as the same user can read process memory or files. Keep `ACC_HOME` private and do not expose the daemon through a reverse proxy without a new authentication boundary. |
| Token or lease path is replaced with a symlink | Secure daemon files are opened with `O_NOFOLLOW` where available, must be regular current-user files, and require mode `0600` on POSIX | Platform guarantees vary, especially on Windows. Put `ACC_HOME` on a local filesystem owned by the user. |
| Two workers mutate the same local state | Single-daemon lease, transactional claims, owner checks, heartbeats, SQLite `BEGIN IMMEDIATE`, busy timeout | Separate CLI invocations can still contend. Prefer one daemon/worker for steady-state operation. |
| Agent escapes a repository branch | Dedicated Git worktree, path containment checks, clean-repository preconditions, direct argv spawning | A worktree is not an OS sandbox. An agent can read or modify anything the user can access unless its own sandbox prevents it. Use a disposable account/container for hostile repositories. |
| Shell injection through task or verification text | Built-in agent and verification processes use `spawn` with `shell: false`; verifier parses to argv | The executable itself can interpret arguments or execute project scripts. Review verification commands and dependency scripts as code. |
| Runaway or noisy child process | Default process timeout, per-stream output caps, POSIX process-group termination, PID/run-token recovery checks | Child-tree termination is weaker on Windows, and a process may daemonize beyond the group. Use stronger OS isolation for high-risk tasks. |
| Prompt injection in repository, issue, plan, or remote response | Explicit task scope, role-specific read/write modes, success criteria, independent verifier, evidence and review gates | Models can still follow malicious instructions or exfiltrate accessible data over allowed networks. Minimize credentials and network access. |
| Adapter lies about capability or result | Strict manifest/RPC schemas, conformance suite, artifact containment, secret canary, independent verification | Conformance is behavioral sampling, not sandboxing or formal proof. Vet adapter source and pin its binary/digest. |
| Secret leaks into logs or artifacts | Separate artifacts, output caps, conformance canary, explicit artifact verification | General automatic redaction is not guaranteed. Treat all prompts, stdout, stderr, screenshots, and handoffs as potentially sensitive; inspect before sharing. |
| Artifact metadata points outside storage | Canonical-path containment, lstat/realpath checks, SHA-256 and size verification | A privileged local attacker can change both files and database. Back up or export evidence to an independently protected store when non-repudiation matters. |
| Duplicate external side effect after crash | Idempotency records, durable remote handle, recovery cancellation, fail-closed retry when cancellation is ambiguous | Providers may accept an operation and time out before returning a receipt. Reconcile at the provider before using the explicit duplicate-risk override. |
| Forged or modified ACCP message | Ed25519 signature, canonical signed envelope, payload digest, workspace/session scope, UUIDv7 IDs, clock and expiry checks | Signing provides integrity and authentication, not confidentiality. A stolen private key or compromised peer can sign harmful valid messages. |
| Replay or reordering | Message IDs, sequence field, bounded deduplication, mandatory idempotency keys for commands/proposals, durable event cursors, saved offer answers | The public alpha node does not yet enforce every sequence-regression rule or persist the message-ID dedup window across restart. Rely on idempotency and cursors, and do not claim full ACCP endpoint conformance yet. |
| Event buffer exhaustion | Bounded journal, negotiated batch limits, truncation records; completion/effect/verification event classes are protected from dropping | Protected events can exceed the configured bound. Monitor disk and reconcile truncations before accepting completion. |
| Database downgrade or corrupt migration | Forward-only versions, transaction per migration, pre-migration `VACUUM INTO` backup when data exists, row-count guard, integrity check, reject newer versions | Backups are on the same filesystem by default. Copy critical backups elsewhere and test restoration. |
| Compromised dependency or CLI on `PATH` | Lockfile, license/security checks, pinned release process, adapter availability/auth probes | The runtime executes configured binaries. Pin trusted paths with `ACC_CODEX_COMMAND` and `ACC_CLAUDE_COMMAND`, protect installation directories, and verify releases. |

## Node key storage: actual behavior

Enrollment generates an Ed25519 keypair in the node process and sends only the public key. The current implementation then stores:

- `ACC_HOME/node/key.pem`: unencrypted PKCS#8 PEM private key;
- `ACC_HOME/node/credentials.json`: node ID, workspace ID, and controller public key.

Enrollment creates or tightens the node directory to mode `0700` and creates or tightens both files to mode `0600` on POSIX. `loadNodeIdentity` rejects files that remain accessible by group or other users. This is file permission protection, not encryption at rest and not an OS keychain. Unlike the daemon-token loader, node identity loading currently follows symlinks and does not re-check file ownership or require a regular file. It also does not re-check the node directory mode.

Until a keystore abstraction is added:

- use a dedicated local account and an encrypted disk;
- verify `ACC_HOME/node` ownership and permissions before connecting;
- never sync or commit `ACC_HOME`;
- rotate by revoking the node remotely, removing the old identity only after preserving needed journal evidence, and enrolling a new key;
- treat a copied `key.pem` as a full node-identity compromise.

## Network requirements

The OpenClaw adapter and the ACCP enrollment/plan-fetch clients require HTTPS, except that HTTP is allowed for explicit loopback development on `localhost`, `127.0.0.1`, and `::1`. The ACCP WebSocket client likewise requires `wss://`, with `ws://` allowed only on those loopback hosts. User information in a URL is rejected. TLS certificate validation is delegated to the Node.js runtime. Signed ACCP envelopes do not encrypt task content or artifacts.

Do not publish the loopback daemon directly to a LAN or the internet. It has a single local bearer-token model, not tenant-aware authentication, authorization, rate plans, or browser-session protection suitable for a hosted product.

## Security review gates

A release or deployment should stop if any of these are unresolved:

- secrets, tokens, private keys, or real customer payloads appear in source, fixtures, reports, or artifacts;
- the protocol artifact generation check, test suite, adapter fixture conformance, license policy, or action pin check fails;
- a migration lacks recovery proof or loses undeclared rows;
- a new adapter requests broader workspace, network, secret, or side-effect capability than its documented task requires;
- a non-loopback control API is proposed without a separate production authentication and authorization design;
- federation is called production-ready before heartbeat, sequence, command handling, key hardening, and end-to-end controller conformance are complete.
